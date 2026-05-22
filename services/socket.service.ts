import { Server } from "socket.io";
import { AuthenticatedSocket } from "../middleware/socketAuth";
import mongoose from "mongoose";
import crypto from "crypto";

import DelivererModel from "../models/deliverer.model";
import TransporterModel from "../models/transporter.model";
import ClientModel from "../models/client.model";
import SupervisorModel from "../models/supervisor.model";
import FreelancerModel from "../models/freelancer.model";
import PackageModel from "../models/package.model";
import ManifestModel from "../models/manifest.model";
import RouteModel from "../models/route.model";
import StopQrSessionModel from "../models/stopQrSession.model";
import { IUser } from "../models/user.model";
import sendSMS from "../utils/sendSMS";
import PaymentModel from "../models/payment.model";

import { PresenceService } from "./presence.service";

export type DeliveryUserRole =
  | "deliverer"
  | "transporter"
  | "client"
  | "freelancer"
  | "supervisor"
  | "manager"
  | "admin";

interface LocationUpdateData {
  userId: string;
  role: DeliveryUserRole;
  coordinates: [number, number];
  timestamp: Date;
}

interface ActiveDelivery {
  packageId: string;
  delivererId: string;
  clientId?: string;
}

interface ActiveTransit {
  packageId: string;
  transporterId: string;
  originBranchId: string;
  destinationBranchId: string;
}

interface ActiveManifestTransit {
  manifestId: string;
  manifestCode: string;
  transporterUserId: string;
  originBranchId: string;
  destinationBranchId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isHubRoute(routeType: string): boolean {
  return routeType === "hub_to_hub" || routeType === "hub_to_branch";
}

function stopLoadCount(stop: any, routeType: string): number {
  if (isHubRoute(routeType)) return stop.manifestIds?.length ?? 0;
  return stop.packageIds?.length ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  QR Flow Overview
// ─────────────────────────────────────────────────────────────────────────────
//
//  BOTH hub_to_hub and hub_to_branch use the same two-step handshake
//  instead of the old one-shot "complete_stop":
//
//  Step 1 — transporter:request_stop_qr
//    • Transporter taps "Complete / I've arrived" at a stop.
//    • Server runs the same proximity + order guards as before.
//    • Server creates a StopQrSession (code, expiresAt=30min).
//    • Server emits  branch:show_stop_qr  → branch room (supervisor sees QR).
//    • Server emits  transporter:stop_qr_ready  → transporter (confirmation).
//
//  Step 2 — transporter:scan_stop_qr
//    • Transporter scans the QR displayed at the branch.
//    • Server verifies: session exists, not expired, not already verified,
//      belongs to this transporter + route + stop.
//    • Server marks session verified, then runs the original complete_stop
//      logic (manifest updates, route advance / complete, stats, broadcasts).
//    • Emits  transporter:stop_completed  or  transporter:route_completed
//      as appropriate, plus  branch:arrival_confirmed  to the branch room.
//
//  hub_to_hub specifics
//    • Only 1 stop (the destination hub).  isLastStop is always true.
//    • After QR scan → route completed, transporter's currentBranchId updated
//      to the destination hub (ready for the return trip).
//
//  hub_to_branch specifics
//    • Multiple stops (local branches served by the hub).
//    • Non-last stop → stop completed, next stop advanced.
//    • Last stop → route completed, transporter freed.
//
// ─────────────────────────────────────────────────────────────────────────────

export class SocketService {
  private io: Server;

  private delivererSockets: Map<string, string> = new Map();
  private transporterSockets: Map<string, string> = new Map();
  private clientSockets: Map<string, string> = new Map();
  private freelancerSockets: Map<string, string> = new Map();
  private supervisorSockets: Map<string, string> = new Map();
  private managerSockets: Map<string, string> = new Map();
  private adminSockets: Map<string, string> = new Map();

  private activeDeliveries: Map<string, ActiveDelivery> = new Map();
  private activeTransits: Map<string, ActiveTransit> = new Map();
  private activeManifestTransits: Map<string, ActiveManifestTransit> =
    new Map();
  private deliveryOTPs: Map<string, { code: string; expiresAt: number }> =
    new Map();

  private disconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  // ── Room name helpers ──────────────────────────────────────────────────────

  private getPackageRoom = (id: string) => `package_${id}`;
  private getBranchRoom = (id: string) => `branch_${id}`;
  private getCompanyRoom = (id: string) => `company_${id}`;
  private getRouteRoom = (id: string) => `route_${id}`;
  private getManifestRoom = (id: string) => `manifest_${id}`;

  private calculateDistance(
    c1: [number, number],
    c2: [number, number],
  ): number {
    const [lng1, lat1] = c1;
    const [lng2, lat2] = c2;
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad = (d: number) => d * (Math.PI / 180);

  constructor(io: Server) {
    this.io = io;
    this.setupSocketHandlers();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  private setupSocketHandlers(): void {
    this.io.on("connection", async (socket: AuthenticatedSocket) => {
      const user = socket.user as IUser & { _id: mongoose.Types.ObjectId };
      if (!user) {
        socket.disconnect();
        return;
      }

      const userId = user._id.toString();
      const role = user.role as DeliveryUserRole;

      console.log(
        `[Socket] Connected: userId=${userId} role=${role} socketId=${socket.id}`,
      );

      this.registerSocket(userId, role, socket.id);

      if (role === "deliverer" || role === "transporter") {
        const pending = this.disconnectTimers.get(userId);
        if (pending) {
          clearTimeout(pending);
          this.disconnectTimers.delete(userId);
        }
        await PresenceService.setOnline(userId, role).catch((e: any) =>
          console.error("[Socket] PresenceService.setOnline:", e.message),
        );
      }

      await this.joinRoleRooms(socket, userId, role);

      socket.emit("connected", {
        message: "Socket connected successfully",
        userId,
        role,
        socketId: socket.id,
        timestamp: new Date(),
      });

      await this.broadcastOnlineStatus(userId, role, true);

      // ── Reconnect resume: push any unfinished work back to the client ──────
      if (role === "deliverer" || role === "transporter") {
        await this.resumeActiveSession(socket, userId, role);
      }

      // ══════════════════════════════════════════════════════════════════════
      //  LOCATION UPDATE
      // ══════════════════════════════════════════════════════════════════════

      socket.on(
        "update_location",
        async (data: { coordinates: [number, number] }) => {
          try {
            if (!data?.coordinates || data.coordinates.length !== 2) {
              socket.emit("location_update_error", {
                message: "Invalid coordinates.",
              });
              return;
            }
            const [lng, lat] = data.coordinates;
            if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
              socket.emit("location_update_error", {
                message: "Coordinates out of range.",
              });
              return;
            }

            if (role === "deliverer") {
              await DelivererModel.findOneAndUpdate(
                { userId },
                {
                  currentLocation: {
                    type: "Point",
                    coordinates: data.coordinates,
                  },
                  lastLocationUpdate: new Date(),
                  lastActiveAt: new Date(),
                },
              );
              await this.broadcastDelivererLocation(userId, data.coordinates);
            } else if (role === "transporter") {
              await TransporterModel.findOneAndUpdate(
                { userId },
                { lastActiveAt: new Date() },
              );
              await this.broadcastTransporterLocation(userId, data.coordinates);
            } else if (role === "client") {
              await ClientModel.findOneAndUpdate(
                { userId },
                {
                  currentLocation: {
                    type: "Point",
                    coordinates: data.coordinates,
                    timestamp: new Date(),
                  },
                },
              );
            }

            socket.emit("location_update_success", {
              coordinates: data.coordinates,
              timestamp: new Date(),
            });
          } catch (error: any) {
            socket.emit("location_update_error", {
              message: "Failed to update location.",
              error: error.message,
            });
          }
        },
      );

      // ══════════════════════════════════════════════════════════════════════
      //  AVAILABILITY STATUS
      // ══════════════════════════════════════════════════════════════════════

      const availabilityHandler = async (data: {
        status:
          | "available"
          | "on_route"
          | "off_duty"
          | "on_break"
          | "maintenance";
      }) => {
        try {
          const allowed = [
            "available",
            "on_route",
            "off_duty",
            "on_break",
            "maintenance",
          ];
          if (!data?.status || !allowed.includes(data.status)) {
            socket.emit("availability_change_error", {
              message: `Invalid status. Allowed: ${allowed.join(", ")}`,
            });
            return;
          }
          if (role === "deliverer") {
            await DelivererModel.findOneAndUpdate(
              { userId },
              { availabilityStatus: data.status, lastActiveAt: new Date() },
            );
            await this.notifyDelivererStatusToTrackers(userId, data.status);
          } else if (role === "transporter") {
            await TransporterModel.findOneAndUpdate(
              { userId },
              { availabilityStatus: data.status, lastActiveAt: new Date() },
            );
          }
          socket.emit("availability_change_success", {
            status: data.status,
            timestamp: new Date(),
          });
        } catch (error: any) {
          socket.emit("availability_change_error", {
            message: "Failed to update availability.",
            error: error.message,
          });
        }
      };

      if (role === "deliverer" || role === "transporter") {
        socket.on("change_availability", availabilityHandler);
      }

      // ══════════════════════════════════════════════════════════════════════
      //  TRANSPORTER ROUTE EVENTS
      // ══════════════════════════════════════════════════════════════════════

      if (role === "transporter") {
        // ── start_route ──────────────────────────────────────────────────────

        socket.on("start_route", async (data: { routeId: string }) => {
          try {
            if (
              !data?.routeId ||
              !mongoose.Types.ObjectId.isValid(data.routeId)
            ) {
              socket.emit("route_error", {
                code: "INVALID_ROUTE_ID",
                message: "Invalid routeId.",
              });
              return;
            }

            const transporter = await TransporterModel.findOne({
              userId,
            }).lean();
            if (!transporter) {
              socket.emit("route_error", {
                code: "NOT_FOUND",
                message: "Transporter not found.",
              });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedTransporterId: transporter._id,
              status: "assigned",
            });
            if (!route) {
              socket.emit("route_error", {
                code: "ROUTE_NOT_FOUND",
                message: "Route not found or not assigned to you.",
              });
              return;
            }

            await route.startRoute();
            socket.join(this.getRouteRoom(data.routeId));

            await TransporterModel.findByIdAndUpdate(transporter._id, {
              availabilityStatus: "on_route",
              lastActiveAt: new Date(),
            });

            if (isHubRoute(route.type)) {
              const allManifestIds = route.stops.flatMap(
                (s: any) => s.manifestIds ?? [],
              );
              if (allManifestIds.length > 0) {
                await ManifestModel.updateMany(
                  {
                    _id: { $in: allManifestIds },
                    status: { $in: ["sealed", "loaded"] },
                  },
                  {
                    $set: {
                      status: "in_transit",
                      departedAt: new Date(),
                      "transportLeg.departedAt": new Date(),
                    },
                  },
                );
              }
            }

            const firstStop = route.stops[0];
            const hubRoute = isHubRoute(route.type);

            if (transporter.currentBranchId) {
              this.io
                .to(this.getBranchRoom(transporter.currentBranchId.toString()))
                .emit("transporter_route_started", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  routeType: route.type,
                  transporterId: transporter._id,
                  userId,
                  totalStops: route.stops.length,
                  firstStop: firstStop
                    ? {
                        stopId: firstStop._id,
                        branchId: firstStop.branchId,
                        address: firstStop.address,
                        location: firstStop.location.coordinates,
                        loadCount: stopLoadCount(firstStop, route.type),
                        loadUnit: hubRoute ? "manifests" : "packages",
                      }
                    : null,
                  actualStart: route.actualStart,
                  scheduledEnd: route.scheduledEnd,
                  timestamp: new Date(),
                });
            }

            socket.emit("route_started", {
              routeId: data.routeId,
              routeNumber: route.routeNumber,
              routeType: route.type,
              status: "active",
              currentStopIndex: 0,
              totalStops: route.stops.length,
              currentStop: firstStop
                ? {
                    stopId: firstStop._id,
                    branchId: firstStop.branchId,
                    address: firstStop.address,
                    location: firstStop.location.coordinates,
                    loadCount: stopLoadCount(firstStop, route.type),
                    loadUnit: hubRoute ? "manifests" : "packages",
                    manifestIds: hubRoute
                      ? (firstStop.manifestIds ?? [])
                      : undefined,
                    packageIds: !hubRoute ? firstStop.packageIds : undefined,
                    order: firstStop.order,
                  }
                : null,
              scheduledEnd: route.scheduledEnd,
              timestamp: new Date(),
            });

            console.log(
              `[Socket] Transporter ${userId} started route ${data.routeId} (${route.type})`,
            );
          } catch (err: any) {
            socket.emit("route_error", {
              code: "START_FAILED",
              message: err.message || "Failed to start route.",
            });
          }
        });

        // ── arrived_at_stop ──────────────────────────────────────────────────

        socket.on(
          "arrived_at_stop",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
          }) => {
            try {
              if (
                !data?.routeId ||
                !mongoose.Types.ObjectId.isValid(data.routeId)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                return;
              }
              if (data.stopIndex === undefined || data.stopIndex < 0) {
                socket.emit("route_error", {
                  code: "INVALID_STOP",
                  message: "Invalid stopIndex.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }

              const transporter = await TransporterModel.findOne({
                userId,
              }).lean();
              if (!transporter) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Transporter not found.",
                });
                return;
              }

              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedTransporterId: transporter._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }

              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }

              const stop = route.stops[data.stopIndex];
              if (!stop) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop not found.",
                });
                return;
              }

              const hubRoute = isHubRoute(route.type);
              const maxDistanceM = hubRoute ? 500 : 50;
              const distanceMeters =
                this.calculateDistance(
                  data.coordinates,
                  stop.location.coordinates,
                ) * 1000;

              if (distanceMeters > maxDistanceM) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be within ${maxDistanceM}m. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: maxDistanceM,
                  stopLocation: stop.location.coordinates,
                });
                return;
              }

              stop.status = "arrived";
              stop.actualArrival = new Date();
              await route.save();

              await TransporterModel.findByIdAndUpdate(transporter._id, {
                lastActiveAt: new Date(),
              });

              const loadCount = stopLoadCount(stop, route.type);

              if (stop.branchId) {
                this.io
                  .to(this.getBranchRoom(stop.branchId.toString()))
                  .emit(
                    hubRoute
                      ? "hub_transporter_arrived"
                      : "transporter_arrived_at_branch",
                    {
                      routeId: data.routeId,
                      routeNumber: route.routeNumber,
                      routeType: route.type,
                      transporterId: transporter._id,
                      stopIndex: data.stopIndex,
                      stopId: stop._id,
                      branchId: stop.branchId,
                      distanceMeters: Math.round(distanceMeters),
                      loadCount,
                      loadUnit: hubRoute ? "manifests" : "packages",
                      manifestIds: hubRoute
                        ? (stop.manifestIds ?? [])
                        : undefined,
                      timestamp: new Date(),
                    },
                  );
              }

              this.io.to(this.getRouteRoom(data.routeId)).emit("stop_arrived", {
                routeId: data.routeId,
                stopIndex: data.stopIndex,
                stopId: stop._id,
                branchId: stop.branchId,
                timestamp: new Date(),
              });

              socket.emit("arrived_at_stop_confirmed", {
                routeId: data.routeId,
                stopIndex: data.stopIndex,
                stopId: stop._id,
                branchId: stop.branchId,
                address: stop.address,
                loadCount,
                loadUnit: hubRoute ? "manifests" : "packages",
                manifestIds: hubRoute ? (stop.manifestIds ?? []) : undefined,
                packageIds: !hubRoute ? stop.packageIds : undefined,
                distanceMeters: Math.round(distanceMeters),
                timestamp: new Date(),
              });

              console.log(
                `[Socket] Transporter ${userId} arrived at stop ${data.stopIndex} (${route.type})`,
              );
            } catch (err: any) {
              socket.emit("route_error", {
                code: "ARRIVE_FAILED",
                message: err.message || "Failed to mark arrival.",
              });
            }
          },
        );

        // ── request_stop_qr ──────────────────────────────────────────────────
        //
        // NEW — Step 1 of the QR handshake.
        //
        // Transporter taps "Complete Stop" / "Complete Route" in the app.
        // Server validates proximity + order, then generates a StopQrSession.
        // The QR code is pushed to the branch room (supervisor displays it).
        // The transporter gets a "ready to scan" confirmation.
        //
        // Replaces the old "complete_stop" for hub routes.
        // Non-hub routes still use the original complete_stop flow below.

        socket.on(
          "request_stop_qr",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            // Optional manifest list for partial discrepancy notes (hub routes)
            completedManifestIds?: string[];
            discrepancyManifestIds?: string[];
            notes?: string;
          }) => {
            try {
              if (
                !data?.routeId ||
                !mongoose.Types.ObjectId.isValid(data.routeId)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                return;
              }
              if (data.stopIndex === undefined || data.stopIndex < 0) {
                socket.emit("route_error", {
                  code: "INVALID_STOP",
                  message: "Invalid stopIndex.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }

              const transporter = await TransporterModel.findOne({
                userId,
              }).lean();
              if (!transporter) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Transporter not found.",
                });
                return;
              }

              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedTransporterId: transporter._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }

              if (!isHubRoute(route.type)) {
                socket.emit("route_error", {
                  code: "NOT_A_HUB_ROUTE",
                  message:
                    "QR handshake is only for hub_to_hub and hub_to_branch routes. Use complete_stop instead.",
                });
                return;
              }

              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }

              const stop = route.stops[data.stopIndex];
              if (!stop) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop not found.",
                });
                return;
              }

              if (
                !["pending", "arrived", "in_progress"].includes(stop.status)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_STOP_STATUS",
                  message: `Stop status '${stop.status}' cannot be completed.`,
                });
                return;
              }

              // Proximity guard: hub stops allow 500m
              const distanceMeters =
                this.calculateDistance(
                  data.coordinates,
                  stop.location.coordinates,
                ) * 1000;
              if (distanceMeters > 500) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be within 500m of the stop. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: 500,
                  stopLocation: stop.location.coordinates,
                });
                return;
              }

              // Cancel any existing unexpired QR session for this stop to avoid duplicates
              await StopQrSessionModel.updateMany(
                {
                  routeId: new mongoose.Types.ObjectId(data.routeId),
                  stopIndex: data.stopIndex,
                  verified: false,
                  expiresAt: { $gt: new Date() },
                },
                { $set: { expiresAt: new Date() } }, // expire immediately
              );

              // Generate a cryptographically secure QR code (hex string)
              const qrCode = crypto.randomBytes(32).toString("hex");
              const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
              const isLastStop = data.stopIndex === route.stops.length - 1;

              const manifestCount = stop.manifestIds?.length ?? 0;
              const packageCount = stop.packageIds?.length ?? 0;

              const session = await StopQrSessionModel.create({
                routeId: new mongoose.Types.ObjectId(data.routeId),
                stopIndex: data.stopIndex,
                stopId: stop._id,
                transporterId: transporter._id,
                branchId: stop.branchId,
                manifestCount,
                packageCount,
                isLastStop,
                code: qrCode,
                expiresAt,
                verified: false,
              });

              // Stash the pending manifest breakdown on the session document
              // so scan_stop_qr can use them without re-sending.
              // We piggy-back using a transient field (not in schema — attach to
              // the in-memory object for the pending scan, then pass via the QR
              // payload as metadata so the transporter app can echo them back).
              const pendingPayload = {
                completedManifestIds: data.completedManifestIds ?? [],
                discrepancyManifestIds: data.discrepancyManifestIds ?? [],
                notes: data.notes ?? "",
              };

              // ── Notify branch room: display QR ───────────────────────────────
              if (stop.branchId) {
                this.io
                  .to(this.getBranchRoom(stop.branchId.toString()))
                  .emit("branch:show_stop_qr", {
                    sessionId: session._id,
                    qrCode, // branch app encodes this into a QR image
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    routeType: route.type,
                    stopIndex: data.stopIndex,
                    stopId: stop._id,
                    branchId: stop.branchId,
                    transporterId: transporter._id,
                    manifestCount,
                    packageCount,
                    isLastStop,
                    expiresAt,
                    message: isLastStop
                      ? "Transporter has arrived with the final delivery. Please scan to confirm receipt."
                      : `Transporter has arrived at stop ${data.stopIndex + 1}. Please scan to confirm receipt.`,
                    timestamp: new Date(),
                  });
              }

              // ── Confirm to transporter: ready to scan ────────────────────────
              socket.emit("transporter:stop_qr_ready", {
                sessionId: session._id,
                routeId: data.routeId,
                stopIndex: data.stopIndex,
                stopId: stop._id,
                branchId: stop.branchId,
                isLastStop,
                manifestCount,
                packageCount,
                expiresAt,
                pendingPayload, // echoed back so transporter app can include in scan event
                message:
                  "QR code displayed at branch. Please scan it to complete the stop.",
                timestamp: new Date(),
              });

              console.log(
                `[Socket] QR generated for transporter ${userId} stop ${data.stopIndex} ` +
                  `route ${data.routeId} (${route.type}) — session ${session._id}`,
              );
            } catch (err: any) {
              console.error("[Socket] request_stop_qr failed:", err);
              socket.emit("route_error", {
                code: "QR_GENERATION_FAILED",
                message: err.message || "Failed to generate QR.",
              });
            }
          },
        );

        // ── scan_stop_qr ─────────────────────────────────────────────────────
        //
        // NEW — Step 2 of the QR handshake.
        //
        // Transporter scans the QR shown by the branch supervisor.
        // Server verifies the session, then executes the full stop-completion
        // logic (manifest/package updates, route advance or complete, stats).
        //
        // Payload mirrors what the transporter received in stop_qr_ready so
        // the server can re-use the manifest breakdown without another round-trip.

        socket.on(
          "scan_stop_qr",
          async (data: {
            sessionId: string; // StopQrSession._id
            qrCode: string; // the scanned code string
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            // Manifest breakdown (echoed from pendingPayload in stop_qr_ready)
            completedManifestIds?: string[];
            discrepancyManifestIds?: string[];
            notes?: string;
          }) => {
            try {
              // ── Basic input guards ───────────────────────────────────────────
              if (
                !data?.sessionId ||
                !mongoose.Types.ObjectId.isValid(data.sessionId)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_SESSION_ID",
                  message: "Invalid sessionId.",
                });
                return;
              }
              if (!data?.qrCode || typeof data.qrCode !== "string") {
                socket.emit("route_error", {
                  code: "QR_CODE_REQUIRED",
                  message: "qrCode is required.",
                });
                return;
              }
              if (
                !data?.routeId ||
                !mongoose.Types.ObjectId.isValid(data.routeId)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }

              const transporter = await TransporterModel.findOne({
                userId,
              }).lean();
              if (!transporter) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Transporter not found.",
                });
                return;
              }

              // ── Load and validate the QR session ────────────────────────────
              const session = await StopQrSessionModel.findById(data.sessionId);
              if (!session) {
                socket.emit("route_error", {
                  code: "SESSION_NOT_FOUND",
                  message: "QR session not found.",
                });
                return;
              }
              if (session.verified) {
                socket.emit("route_error", {
                  code: "ALREADY_VERIFIED",
                  message: "This QR code has already been used.",
                });
                return;
              }
              if (session.expiresAt < new Date()) {
                socket.emit("route_error", {
                  code: "QR_EXPIRED",
                  message: "QR code has expired. Please request a new one.",
                  expiredAt: session.expiresAt,
                });
                return;
              }
              if (session.code !== data.qrCode.trim()) {
                socket.emit("route_error", {
                  code: "QR_MISMATCH",
                  message: "Invalid QR code.",
                });
                return;
              }
              if (
                session.transporterId.toString() !== transporter._id.toString()
              ) {
                socket.emit("route_error", {
                  code: "WRONG_TRANSPORTER",
                  message: "QR belongs to a different transporter.",
                });
                return;
              }
              if (session.routeId.toString() !== data.routeId) {
                socket.emit("route_error", {
                  code: "WRONG_ROUTE",
                  message: "QR belongs to a different route.",
                });
                return;
              }
              if (session.stopIndex !== data.stopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `QR is for stop ${session.stopIndex}, not ${data.stopIndex}.`,
                });
                return;
              }

              // ── Load route ───────────────────────────────────────────────────
              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedTransporterId: transporter._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }

              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }

              const stop = route.stops[data.stopIndex];
              if (!stop) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop not found.",
                });
                return;
              }

              // Proximity guard (still enforced at scan time — transporter must stay on-site)
              const distanceMeters =
                this.calculateDistance(
                  data.coordinates,
                  stop.location.coordinates,
                ) * 1000;
              if (distanceMeters > 500) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be within 500m to scan. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: 500,
                });
                return;
              }

              // ── Mark QR session as verified ──────────────────────────────────
              session.verified = true;
              session.verifiedAt = new Date();
              await session.save();

              const isLastStop = data.stopIndex === route.stops.length - 1;
              const routeRoom = this.getRouteRoom(data.routeId);

              // ── Manifest breakdown ───────────────────────────────────────────
              const stopManifestSet = new Set(
                (stop.manifestIds ?? []).map((id: mongoose.Types.ObjectId) =>
                  id.toString(),
                ),
              );

              const completedManifestOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of data.completedManifestIds ?? []) {
                if (
                  !mongoose.Types.ObjectId.isValid(idStr) ||
                  !stopManifestSet.has(idStr)
                ) {
                  socket.emit("route_error", {
                    code: "INVALID_MANIFEST_ID",
                    message: `Invalid or out-of-stop manifest ID: ${idStr}`,
                  });
                  return;
                }
                completedManifestOids.push(new mongoose.Types.ObjectId(idStr));
              }

              const discrepancyManifestOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of data.discrepancyManifestIds ?? []) {
                if (
                  !mongoose.Types.ObjectId.isValid(idStr) ||
                  !stopManifestSet.has(idStr)
                ) {
                  socket.emit("route_error", {
                    code: "INVALID_MANIFEST_ID",
                    message: `Invalid or out-of-stop manifest ID: ${idStr}`,
                  });
                  return;
                }
                discrepancyManifestOids.push(
                  new mongoose.Types.ObjectId(idStr),
                );
              }

              // Default: treat all stop manifests as completed when no breakdown given
              const finalCompletedManifests =
                completedManifestOids.length > 0
                  ? completedManifestOids
                  : ((stop.manifestIds ?? []) as mongoose.Types.ObjectId[]);

              // ── Persist manifest breakdown on route stop ─────────────────────
              stop.completedManifests = finalCompletedManifests;
              stop.discrepancyManifests = discrepancyManifestOids;

              await route.completeStop(data.stopIndex, [], [], data.notes);

              // ── Update manifest statuses → arrived + cascade to packages ─────
              if (finalCompletedManifests.length > 0) {
                await ManifestModel.updateMany(
                  {
                    _id: { $in: finalCompletedManifests },
                    status: "in_transit",
                  },
                  {
                    $set: {
                      status: "arrived",
                      arrivedAt: new Date(),
                      "transportLeg.arrivedAt": new Date(),
                    },
                  },
                );
                for (const manifestId of finalCompletedManifests) {
                  const manifest = await ManifestModel.findById(manifestId);
                  if (manifest) {
                    await manifest.markArrived(
                      new mongoose.Types.ObjectId(userId),
                    );
                  }
                }
              }

              if (discrepancyManifestOids.length > 0) {
                await ManifestModel.updateMany(
                  { _id: { $in: discrepancyManifestOids } },
                  { $set: { status: "discrepancy" } },
                );
              }

              // ── Notify branch: arrival confirmed ─────────────────────────────
              if (stop.branchId) {
                this.io
                  .to(this.getBranchRoom(stop.branchId.toString()))
                  .emit("branch:arrival_confirmed", {
                    sessionId: session._id,
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    routeType: route.type,
                    transporterId: transporter._id,
                    stopIndex: data.stopIndex,
                    stopId: stop._id,
                    branchId: stop.branchId,
                    completedManifests: finalCompletedManifests.length,
                    discrepancyManifests: discrepancyManifestOids.length,
                    isLastStop,
                    routeCompleted: isLastStop,
                    timestamp: new Date(),
                  });
              }

              // ── Route branch: hub_to_hub vs hub_to_branch ────────────────────

              if (isLastStop) {
                // ── Complete the route ─────────────────────────────────────────
                await route.completeRoute(data.notes);

                if (route.type === "hub_to_hub" && stop.branchId) {
                  // Update transporter's home hub to the destination
                  await TransporterModel.findByIdAndUpdate(transporter._id, {
                    availabilityStatus: "available",
                    currentRouteId: null,
                    currentBranchId: stop.branchId, // now stationed at destination hub
                    lastActiveAt: new Date(),
                    $inc: { totalTrips: 1, completedTrips: 1 },
                  });
                } else {
                  await TransporterModel.findByIdAndUpdate(transporter._id, {
                    availabilityStatus: "available",
                    currentRouteId: null,
                    lastActiveAt: new Date(),
                    $inc: { totalTrips: 1, completedTrips: 1 },
                  });
                }

                // Tell transporter the full route is done
                socket.emit("transporter:route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  routeType: route.type,
                  totalStops: route.stops.length,
                  completedStops: route.completedStops,
                  actualStart: route.actualStart,
                  actualEnd: route.actualEnd,
                  onTimePerformance: route.onTimePerformance,
                  newCurrentBranch:
                    route.type === "hub_to_hub" ? stop.branchId : undefined,
                  message:
                    route.type === "hub_to_hub"
                      ? "Route completed. You are now stationed at the destination hub and available for the return trip."
                      : "All branch stops completed. Route finished — you are now available.",
                  timestamp: new Date(),
                });

                // Notify company room
                this.io
                  .to(this.getCompanyRoom(transporter.companyId.toString()))
                  .emit("transporter_route_completed", {
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    routeType: route.type,
                    transporterId: transporter._id,
                    userId,
                    onTimePerformance: route.onTimePerformance,
                    timestamp: new Date(),
                  });

                this.io.to(routeRoom).emit("route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Transporter ${userId} COMPLETED ${route.type} route ${data.routeId} via QR`,
                );
              } else {
                // ── hub_to_branch: advance to next stop ────────────────────────
                const nextStop = route.stops[data.stopIndex + 1];

                socket.emit("transporter:stop_completed", {
                  routeId: data.routeId,
                  completedStopIndex: data.stopIndex,
                  completedStopId: stop._id,
                  branchId: stop.branchId,
                  completedManifests: finalCompletedManifests.length,
                  discrepancyManifests: discrepancyManifestOids.length,
                  distanceMeters: Math.round(distanceMeters),
                  remainingStops: route.stops.length - (data.stopIndex + 1),
                  nextStop: nextStop
                    ? {
                        stopIndex: data.stopIndex + 1,
                        stopId: nextStop._id,
                        branchId: nextStop.branchId,
                        address: nextStop.address,
                        location: nextStop.location.coordinates,
                        manifestCount: nextStop.manifestIds?.length ?? 0,
                        order: nextStop.order,
                      }
                    : null,
                  message: `Stop ${data.stopIndex + 1} confirmed. Proceed to next branch.`,
                  timestamp: new Date(),
                });

                // Notify the completed branch that transporter is leaving
                if (stop.branchId) {
                  this.io
                    .to(this.getBranchRoom(stop.branchId.toString()))
                    .emit("transporter_left_hub", {
                      routeId: data.routeId,
                      transporterId: transporter._id,
                      completedManifests: finalCompletedManifests.length,
                      timestamp: new Date(),
                    });
                }

                // Notify the next branch that transporter is on the way
                if (nextStop?.branchId) {
                  this.io
                    .to(this.getBranchRoom(nextStop.branchId.toString()))
                    .emit("hub_transporter_en_route", {
                      routeId: data.routeId,
                      routeNumber: route.routeNumber,
                      transporterId: transporter._id,
                      manifestCount: nextStop.manifestIds?.length ?? 0,
                      estimatedArrival: nextStop.expectedArrival,
                      timestamp: new Date(),
                    });
                }

                this.io.to(routeRoom).emit("stop_completed", {
                  routeId: data.routeId,
                  stopIndex: data.stopIndex,
                  stopId: stop._id,
                  nextStopIndex: data.stopIndex + 1,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Transporter ${userId} QR-confirmed hub stop ${data.stopIndex}/${route.stops.length - 1}`,
                );
              }
            } catch (err: any) {
              console.error("[Socket] scan_stop_qr failed:", err);
              socket.emit("route_error", {
                code: "QR_SCAN_FAILED",
                message: err.message || "Failed to process QR scan.",
              });
            }
          },
        );

        // ── complete_stop ────────────────────────────────────────────────────
        //
        // Original flow — kept unchanged for NON-hub routes (package-based).
        // Hub routes must use request_stop_qr → scan_stop_qr instead.

        socket.on(
          "complete_stop",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            completedPackageIds?: string[];
            failedPackageIds?: string[];
            completedManifestIds?: string[];
            discrepancyManifestIds?: string[];
            notes?: string;
          }) => {
            try {
              if (
                !data?.routeId ||
                !mongoose.Types.ObjectId.isValid(data.routeId)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                return;
              }
              if (data.stopIndex === undefined || data.stopIndex < 0) {
                socket.emit("route_error", {
                  code: "INVALID_STOP",
                  message: "Invalid stopIndex.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }

              const transporter = await TransporterModel.findOne({
                userId,
              }).lean();
              if (!transporter) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Transporter not found.",
                });
                return;
              }

              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedTransporterId: transporter._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }

              // Hub routes must go through the QR flow
              if (isHubRoute(route.type)) {
                socket.emit("route_error", {
                  code: "USE_QR_FLOW",
                  message:
                    "Hub routes require QR verification. Use 'request_stop_qr' → 'scan_stop_qr' instead.",
                });
                return;
              }

              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }

              const stop = route.stops[data.stopIndex];
              if (!stop) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop not found.",
                });
                return;
              }

              if (
                !["arrived", "in_progress", "pending"].includes(stop.status)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_STOP_STATUS",
                  message: `Stop status '${stop.status}' cannot be completed.`,
                });
                return;
              }

              const distanceMeters =
                this.calculateDistance(
                  data.coordinates,
                  stop.location.coordinates,
                ) * 1000;
              if (distanceMeters > 50) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be within 50m. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: 50,
                  stopLocation: stop.location.coordinates,
                });
                return;
              }

              const isLastStop = data.stopIndex === route.stops.length - 1;
              const routeRoom = this.getRouteRoom(data.routeId);

              // ── Package-based stop completion ────────────────────────────────
              const stopPackageSet = new Set(
                (stop.packageIds as mongoose.Types.ObjectId[]).map((id) =>
                  id.toString(),
                ),
              );

              const completedOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of data.completedPackageIds ?? []) {
                if (
                  !mongoose.Types.ObjectId.isValid(idStr) ||
                  !stopPackageSet.has(idStr)
                ) {
                  socket.emit("route_error", {
                    code: "INVALID_PACKAGE_ID",
                    message: `Invalid or out-of-stop package: ${idStr}`,
                  });
                  return;
                }
                completedOids.push(new mongoose.Types.ObjectId(idStr));
              }

              const failedOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of data.failedPackageIds ?? []) {
                if (
                  !mongoose.Types.ObjectId.isValid(idStr) ||
                  !stopPackageSet.has(idStr)
                ) {
                  socket.emit("route_error", {
                    code: "INVALID_PACKAGE_ID",
                    message: `Invalid or out-of-stop package: ${idStr}`,
                  });
                  return;
                }
                failedOids.push(new mongoose.Types.ObjectId(idStr));
              }

              const finalCompleted =
                completedOids.length > 0
                  ? completedOids
                  : (stop.packageIds as mongoose.Types.ObjectId[]);

              await route.completeStop(
                data.stopIndex,
                finalCompleted,
                failedOids,
                data.notes,
              );

              if (isLastStop) {
                await route.completeRoute(data.notes);
                await TransporterModel.findByIdAndUpdate(transporter._id, {
                  availabilityStatus: "available",
                  currentRouteId: null,
                  lastActiveAt: new Date(),
                });

                socket.emit("route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  totalStops: route.stops.length,
                  completedStops: route.completedStops,
                  failedStops: route.failedStops,
                  skippedStops: route.skippedStops,
                  actualStart: route.actualStart,
                  actualEnd: route.actualEnd,
                  actualTime: route.actualTime,
                  onTimePerformance: route.onTimePerformance,
                  message: "Route completed successfully!",
                  timestamp: new Date(),
                });

                const branchIds = new Set<string>();
                route.stops.forEach((s: any) => {
                  if (s.branchId) branchIds.add(s.branchId.toString());
                });
                branchIds.forEach((bId) => {
                  this.io
                    .to(this.getBranchRoom(bId))
                    .emit("transporter_route_completed", {
                      routeId: data.routeId,
                      routeNumber: route.routeNumber,
                      transporterId: transporter._id,
                      userId,
                      onTimePerformance: route.onTimePerformance,
                      timestamp: new Date(),
                    });
                });

                this.io
                  .to(this.getCompanyRoom(transporter.companyId.toString()))
                  .emit("transporter_route_completed", {
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    transporterId: transporter._id,
                    userId,
                    onTimePerformance: route.onTimePerformance,
                    timestamp: new Date(),
                  });
                this.io
                  .to(routeRoom)
                  .emit("route_completed", {
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    timestamp: new Date(),
                  });

                console.log(
                  `[Socket] Transporter ${userId} COMPLETED route ${data.routeId}`,
                );
              } else {
                const nextStop = route.stops[data.stopIndex + 1];
                socket.emit("stop_completed", {
                  routeId: data.routeId,
                  completedStopIndex: data.stopIndex,
                  completedStopId: stop._id,
                  branchId: stop.branchId,
                  completedPackages: finalCompleted.length,
                  failedPackages: failedOids.length,
                  distanceMeters: Math.round(distanceMeters),
                  nextStop: nextStop
                    ? {
                        stopIndex: data.stopIndex + 1,
                        stopId: nextStop._id,
                        branchId: nextStop.branchId,
                        address: nextStop.address,
                        location: nextStop.location.coordinates,
                        packageCount: nextStop.packageIds.length,
                        order: nextStop.order,
                      }
                    : null,
                  remainingStops: route.stops.length - (data.stopIndex + 1),
                  timestamp: new Date(),
                });

                if (stop.branchId) {
                  this.io
                    .to(this.getBranchRoom(stop.branchId.toString()))
                    .emit("transporter_left_branch", {
                      routeId: data.routeId,
                      routeNumber: route.routeNumber,
                      transporterId: transporter._id,
                      completedPackages: finalCompleted.length,
                      failedPackages: failedOids.length,
                      timestamp: new Date(),
                    });
                }
                if (nextStop?.branchId) {
                  this.io
                    .to(this.getBranchRoom(nextStop.branchId.toString()))
                    .emit("transporter_en_route_to_branch", {
                      routeId: data.routeId,
                      routeNumber: route.routeNumber,
                      transporterId: transporter._id,
                      packageCount: nextStop.packageIds.length,
                      estimatedArrival: nextStop.expectedArrival,
                      timestamp: new Date(),
                    });
                }
                this.io.to(routeRoom).emit("stop_completed", {
                  routeId: data.routeId,
                  stopIndex: data.stopIndex,
                  stopId: stop._id,
                  nextStopIndex: data.stopIndex + 1,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Transporter ${userId} completed stop ${data.stopIndex}/${route.stops.length - 1}`,
                );
              }
            } catch (err: any) {
              console.error("[Socket] complete_stop failed:", err);
              socket.emit("route_error", {
                code: "COMPLETE_STOP_FAILED",
                message: err.message || "Failed to complete stop.",
              });
            }
          },
        );

        // ── fail_stop ────────────────────────────────────────────────────────

        socket.on(
          "fail_stop",
          async (data: {
            routeId: string;
            stopIndex: number;
            reason: string;
            skippedPackageIds?: string[];
            skippedManifestIds?: string[];
          }) => {
            try {
              if (!data?.routeId || !data?.reason) {
                socket.emit("route_error", {
                  code: "MISSING_DATA",
                  message: "routeId and reason required.",
                });
                return;
              }

              const transporter = await TransporterModel.findOne({
                userId,
              }).lean();
              if (!transporter) return;

              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedTransporterId: transporter._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }

              const skippedOids = (data.skippedPackageIds ?? [])
                .filter((id) => mongoose.Types.ObjectId.isValid(id))
                .map((id) => new mongoose.Types.ObjectId(id));

              await route.failStop(data.stopIndex, data.reason, skippedOids);

              const stop = route.stops[data.stopIndex];
              const isLastStop = data.stopIndex === route.stops.length - 1;
              const hubRoute = isHubRoute(route.type);

              // Expire any pending QR session for this stop if it was a hub route
              if (hubRoute) {
                await StopQrSessionModel.updateMany(
                  {
                    routeId: new mongoose.Types.ObjectId(data.routeId),
                    stopIndex: data.stopIndex,
                    verified: false,
                  },
                  { $set: { expiresAt: new Date() } },
                );
              }

              socket.emit("stop_failed", {
                routeId: data.routeId,
                stopIndex: data.stopIndex,
                stopId: stop?._id,
                branchId: stop?.branchId,
                reason: data.reason,
                remainingStops: isLastStop
                  ? 0
                  : route.stops.length - (data.stopIndex + 1),
                timestamp: new Date(),
              });

              if (stop?.branchId) {
                this.io
                  .to(this.getBranchRoom(stop.branchId.toString()))
                  .emit(
                    hubRoute ? "hub_stop_failed" : "transporter_stop_failed",
                    {
                      routeId: data.routeId,
                      transporterId: transporter._id,
                      stopId: stop._id,
                      branchId: stop.branchId,
                      reason: data.reason,
                      timestamp: new Date(),
                    },
                  );
              }

              if (isLastStop) {
                await route.completeRoute(`Last stop failed: ${data.reason}`);
                await TransporterModel.findByIdAndUpdate(transporter._id, {
                  availabilityStatus: "available",
                  currentRouteId: null,
                  lastActiveAt: new Date(),
                });
                socket.emit("route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  status: "completed",
                  message:
                    "Route completed. Last stop failed — supervisor notified.",
                  timestamp: new Date(),
                });
              }
            } catch (err: any) {
              socket.emit("route_error", {
                code: "FAIL_STOP_FAILED",
                message: err.message || "Failed to record stop failure.",
              });
            }
          },
        );

        // ── pause_route ──────────────────────────────────────────────────────

        socket.on(
          "pause_route",
          async (data: { routeId: string; reason?: string }) => {
            try {
              const transporter = await TransporterModel.findOne({
                userId,
              }).lean();
              if (!transporter) return;
              const route = await RouteModel.findOne({
                _id: data?.routeId,
                assignedTransporterId: transporter._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }
              await route.pauseRoute(data?.reason);
              socket.emit("route_paused", {
                routeId: data.routeId,
                reason: data?.reason,
                pausedAt: new Date(),
              });
              if (transporter.currentBranchId) {
                this.io
                  .to(
                    this.getBranchRoom(transporter.currentBranchId.toString()),
                  )
                  .emit("transporter_route_paused", {
                    routeId: data.routeId,
                    transporterId: transporter._id,
                    reason: data?.reason,
                    timestamp: new Date(),
                  });
              }
            } catch (err: any) {
              socket.emit("route_error", {
                code: "PAUSE_FAILED",
                message: err.message,
              });
            }
          },
        );

        // ── resume_route ─────────────────────────────────────────────────────

        socket.on("resume_route", async (data: { routeId: string }) => {
          try {
            const transporter = await TransporterModel.findOne({
              userId,
            }).lean();
            if (!transporter) return;
            const route = await RouteModel.findOne({
              _id: data?.routeId,
              assignedTransporterId: transporter._id,
              status: "paused",
            });
            if (!route) {
              socket.emit("route_error", {
                code: "ROUTE_NOT_FOUND",
                message: "Paused route not found.",
              });
              return;
            }
            await route.resumeRoute();
            const currentStop = route.stops[route.currentStopIndex];
            const hubRoute = isHubRoute(route.type);
            socket.emit("route_resumed", {
              routeId: data.routeId,
              currentStopIndex: route.currentStopIndex,
              currentStop: currentStop
                ? {
                    stopId: currentStop._id,
                    branchId: currentStop.branchId,
                    address: currentStop.address,
                    location: currentStop.location.coordinates,
                    loadCount: stopLoadCount(currentStop, route.type),
                    loadUnit: hubRoute ? "manifests" : "packages",
                  }
                : null,
              resumedAt: new Date(),
            });
            if (transporter.currentBranchId) {
              this.io
                .to(this.getBranchRoom(transporter.currentBranchId.toString()))
                .emit("transporter_route_resumed", {
                  routeId: data.routeId,
                  transporterId: transporter._id,
                  timestamp: new Date(),
                });
            }
          } catch (err: any) {
            socket.emit("route_error", {
              code: "RESUME_FAILED",
              message: err.message,
            });
          }
        });

        // ── join_route_room ──────────────────────────────────────────────────

        socket.on("join_route_room", async (data: { routeId: string }) => {
          if (!data?.routeId) return;
          const transporter = await TransporterModel.findOne({ userId }).lean();
          if (!transporter) return;
          const route = await RouteModel.findOne({
            _id: data.routeId,
            assignedTransporterId: transporter._id,
            status: { $in: ["active", "paused"] },
          }).lean();
          if (!route) {
            socket.emit("route_error", {
              code: "ROUTE_NOT_FOUND",
              message: "No active/paused route found.",
            });
            return;
          }
          socket.join(this.getRouteRoom(data.routeId));
          const currentStop = route.stops[route.currentStopIndex];
          const hubRoute = isHubRoute(route.type);
          socket.emit("route_rejoined", {
            routeId: data.routeId,
            routeNumber: route.routeNumber,
            routeType: route.type,
            status: route.status,
            currentStopIndex: route.currentStopIndex,
            totalStops: route.stops.length,
            completedStops: route.completedStops,
            currentStop: currentStop
              ? {
                  stopId: currentStop._id,
                  branchId: currentStop.branchId,
                  address: currentStop.address,
                  location: currentStop.location.coordinates,
                  status: currentStop.status,
                  loadCount: stopLoadCount(currentStop, route.type),
                  loadUnit: hubRoute ? "manifests" : "packages",
                  manifestIds: hubRoute
                    ? (currentStop.manifestIds ?? [])
                    : undefined,
                  packageIds: !hubRoute ? currentStop.packageIds : undefined,
                }
              : null,
            timestamp: new Date(),
          });
        });
      } // end if (role === "transporter")

      // ══════════════════════════════════════════════════════════════════════
      //  DELIVERER ROUTE EVENTS  (unchanged from original)
      // ══════════════════════════════════════════════════════════════════════

      if (role === "deliverer") {
        socket.on("start_delivery_route", async (data: { routeId: string }) => {
          try {
            if (
              !data?.routeId ||
              !mongoose.Types.ObjectId.isValid(data.routeId)
            ) {
              socket.emit("route_error", {
                code: "INVALID_ROUTE_ID",
                message: "Invalid routeId.",
              });
              return;
            }
            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) {
              socket.emit("route_error", {
                code: "NOT_FOUND",
                message: "Deliverer not found.",
              });
              return;
            }
            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedDelivererId: deliverer._id,
              status: "assigned",
            });
            if (!route) {
              socket.emit("route_error", {
                code: "ROUTE_NOT_FOUND",
                message: "Route not found or not assigned to you.",
              });
              return;
            }

            await route.startRoute();
            socket.join(this.getRouteRoom(data.routeId));
            await DelivererModel.findByIdAndUpdate(deliverer._id, {
              availabilityStatus: "on_route",
              currentRouteId: route._id,
              lastActiveAt: new Date(),
            });

            if (route.stops.length > 0) {
              await this.generateAndSendDeliveryOTP(route, 0, data.routeId);
            }

            this.io
              .to(this.getBranchRoom(deliverer.branchId.toString()))
              .emit("deliverer_route_started", {
                routeId: data.routeId,
                routeNumber: route.routeNumber,
                delivererId: deliverer._id,
                userId,
                totalStops: route.stops.length,
                actualStart: route.actualStart,
                scheduledEnd: route.scheduledEnd,
                timestamp: new Date(),
              });

            const firstStop = route.stops[0];
            socket.emit("delivery_route_started", {
              routeId: data.routeId,
              routeNumber: route.routeNumber,
              status: "active",
              currentStopIndex: 0,
              totalStops: route.stops.length,
              currentStop: firstStop
                ? {
                    stopId: firstStop._id,
                    clientId: firstStop.clientId,
                    packageId: firstStop.packageIds[0],
                    address: firstStop.address,
                    location: firstStop.location.coordinates,
                    recipientName: (firstStop as any).recipientName,
                    recipientPhone: (firstStop as any).recipientPhone,
                    otpSent: true,
                  }
                : null,
              scheduledEnd: route.scheduledEnd,
              timestamp: new Date(),
            });

            console.log(
              `[Socket] Deliverer ${userId} started delivery route ${data.routeId}`,
            );
          } catch (err: any) {
            socket.emit("route_error", {
              code: "START_FAILED",
              message: err.message || "Failed to start route.",
            });
          }
        });

        socket.on(
          "arrived_at_delivery",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
          }) => {
            try {
              if (
                !data?.routeId ||
                !mongoose.Types.ObjectId.isValid(data.routeId)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }
              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                return;
              }
              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedDelivererId: deliverer._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }
              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }
              const stop = route.stops[data.stopIndex];
              if (!stop) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop not found.",
                });
                return;
              }
              const distanceMeters =
                this.calculateDistance(
                  data.coordinates,
                  stop.location.coordinates,
                ) * 1000;
              if (distanceMeters > 50) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be within 50m. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: 50,
                  stopLocation: stop.location.coordinates,
                });
                return;
              }
              stop.status = "arrived";
              stop.actualArrival = new Date();
              await route.save();
              await DelivererModel.findByIdAndUpdate(deliverer._id, {
                lastActiveAt: new Date(),
              });
              this.io
                .to(this.getBranchRoom(deliverer.branchId.toString()))
                .emit("deliverer_arrived_at_client", {
                  routeId: data.routeId,
                  delivererId: deliverer._id,
                  stopIndex: data.stopIndex,
                  stopId: stop._id,
                  clientId: stop.clientId,
                  distanceMeters: Math.round(distanceMeters),
                  timestamp: new Date(),
                });
              if (stop.packageIds[0]) {
                this.io
                  .to(this.getPackageRoom(stop.packageIds[0].toString()))
                  .emit("deliverer_arrived", {
                    packageId: stop.packageIds[0],
                    delivererId: deliverer._id,
                    distanceMeters: Math.round(distanceMeters),
                    message: "Your deliverer has arrived!",
                    timestamp: new Date(),
                  });
              }
              socket.emit("arrived_at_delivery_confirmed", {
                routeId: data.routeId,
                stopIndex: data.stopIndex,
                stopId: stop._id,
                packageId: stop.packageIds[0],
                address: stop.address,
                distanceMeters: Math.round(distanceMeters),
                message: "Arrival confirmed. Ask the client for the OTP code.",
                timestamp: new Date(),
              });
              console.log(
                `[Socket] Deliverer ${userId} arrived at stop ${data.stopIndex}`,
              );
            } catch (err: any) {
              socket.emit("route_error", {
                code: "ARRIVE_FAILED",
                message: err.message || "Failed to mark arrival.",
              });
            }
          },
        );

        socket.on(
          "complete_delivery",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            otp: string;
            notes?: string;
          }) => {
            try {
              if (
                !data?.routeId ||
                !mongoose.Types.ObjectId.isValid(data.routeId)
              ) {
                socket.emit("route_error", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }
              if (!data?.otp) {
                socket.emit("route_error", {
                  code: "OTP_REQUIRED",
                  message: "OTP required.",
                });
                return;
              }

              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                return;
              }
              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedDelivererId: deliverer._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }
              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }
              const stop = route.stops[data.stopIndex];
              if (!stop || !stop.packageIds[0]) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop or package not found.",
                });
                return;
              }

              const distanceMeters =
                this.calculateDistance(
                  data.coordinates,
                  stop.location.coordinates,
                ) * 1000;
              if (distanceMeters > 50) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be within 50m. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: 50,
                });
                return;
              }

              const packageId = stop.packageIds[0].toString();
              const otpKey = `delivery_otp_${packageId}`;
              const stored = this.deliveryOTPs.get(otpKey);
              if (!stored) {
                socket.emit("route_error", {
                  code: "OTP_NOT_FOUND",
                  message: "No OTP found. Request a new code.",
                });
                return;
              }
              if (Date.now() > stored.expiresAt) {
                this.deliveryOTPs.delete(otpKey);
                await this.generateAndSendDeliveryOTP(
                  route,
                  data.stopIndex,
                  data.routeId,
                );
                socket.emit("route_error", {
                  code: "OTP_EXPIRED",
                  message: "OTP expired. New code sent.",
                });
                return;
              }
              if (stored.code !== data.otp.trim()) {
                socket.emit("route_error", {
                  code: "OTP_MISMATCH",
                  message: "Incorrect OTP.",
                });
                return;
              }

              const pkg = await PackageModel.findById(packageId);
              if (!pkg) {
                socket.emit("route_error", {
                  code: "PACKAGE_NOT_FOUND",
                  message: "Package not found.",
                });
                return;
              }
              await pkg.markAsDelivered(deliverer.userId, data.notes);
              await PaymentModel.findOneAndUpdate(
                { packageId },
                {
                  $set: { status: "collected", delivererId: deliverer.userId },
                },
              );
              await route.completeStop(
                data.stopIndex,
                [new mongoose.Types.ObjectId(packageId)],
                [],
                data.notes,
              );
              this.deliveryOTPs.delete(otpKey);

              const delivererDoc = await DelivererModel.findById(deliverer._id);
              if (delivererDoc) {
                const isCOD = pkg.paymentMethod === "cod";
                await delivererDoc.recordDeliveryPayment(pkg.totalPrice, isCOD);
                delivererDoc.totalDeliveries += 1;
                delivererDoc.successfulDeliveries += 1;
                delivererDoc.lastActiveAt = new Date();
                await delivererDoc.save();
              }

              const isLastStop = data.stopIndex === route.stops.length - 1;
              const routeRoom = this.getRouteRoom(data.routeId);

              this.io
                .to(this.getPackageRoom(packageId))
                .emit("package_delivered", {
                  packageId,
                  deliveredAt: new Date(),
                  message: "Your package has been delivered!",
                  timestamp: new Date(),
                });

              if (isLastStop) {
                await route.completeRoute(data.notes);
                await DelivererModel.findByIdAndUpdate(deliverer._id, {
                  availabilityStatus: "available",
                  currentRouteId: null,
                  lastActiveAt: new Date(),
                });
                socket.emit("delivery_route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  totalStops: route.stops.length,
                  completedStops: route.completedStops,
                  failedStops: route.failedStops,
                  actualStart: route.actualStart,
                  actualEnd: route.actualEnd,
                  actualTime: route.actualTime,
                  onTimePerformance: route.onTimePerformance,
                  message: "Route completed successfully!",
                  timestamp: new Date(),
                });
                this.io
                  .to(this.getBranchRoom(deliverer.branchId.toString()))
                  .emit("deliverer_route_completed", {
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    delivererId: deliverer._id,
                    userId,
                    onTimePerformance: route.onTimePerformance,
                    timestamp: new Date(),
                  });
                this.io
                  .to(routeRoom)
                  .emit("delivery_route_completed", {
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    timestamp: new Date(),
                  });
                console.log(
                  `[Socket] Deliverer ${userId} COMPLETED delivery route ${data.routeId}`,
                );
              } else {
                const nextStop = route.stops[data.stopIndex + 1];
                if (nextStop)
                  await this.generateAndSendDeliveryOTP(
                    route,
                    data.stopIndex + 1,
                    data.routeId,
                  );
                socket.emit("delivery_stop_completed", {
                  routeId: data.routeId,
                  completedStopIndex: data.stopIndex,
                  packageId,
                  distanceMeters: Math.round(distanceMeters),
                  nextStop: nextStop
                    ? {
                        stopIndex: data.stopIndex + 1,
                        stopId: nextStop._id,
                        clientId: nextStop.clientId,
                        packageId: nextStop.packageIds[0],
                        address: nextStop.address,
                        location: nextStop.location.coordinates,
                        otpSent: true,
                      }
                    : null,
                  remainingStops: route.stops.length - (data.stopIndex + 1),
                  timestamp: new Date(),
                });
                this.io.to(routeRoom).emit("delivery_stop_completed", {
                  routeId: data.routeId,
                  stopIndex: data.stopIndex,
                  packageId,
                  timestamp: new Date(),
                });
                console.log(
                  `[Socket] Deliverer ${userId} completed delivery stop ${data.stopIndex}`,
                );
              }
            } catch (err: any) {
              socket.emit("route_error", {
                code: "COMPLETE_FAILED",
                message: err.message || "Failed to complete delivery.",
              });
            }
          },
        );

        socket.on(
          "fail_delivery_attempt",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            reason: string;
            issueType?: "customer_unavailable" | "wrong_address" | "other";
          }) => {
            try {
              if (!data?.routeId || !data?.reason) {
                socket.emit("route_error", {
                  code: "MISSING_DATA",
                  message: "routeId and reason required.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }
              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                return;
              }
              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedDelivererId: deliverer._id,
                status: "active",
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }
              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }
              const stop = route.stops[data.stopIndex];
              if (!stop || !stop.packageIds[0]) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop or package not found.",
                });
                return;
              }
              const distanceMeters =
                this.calculateDistance(
                  data.coordinates,
                  stop.location.coordinates,
                ) * 1000;
              if (distanceMeters > 50) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be within 50m. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: 50,
                });
                return;
              }

              const packageId = stop.packageIds[0].toString();
              const pkg = await PackageModel.findById(packageId);
              if (!pkg) {
                socket.emit("route_error", {
                  code: "PACKAGE_NOT_FOUND",
                  message: "Package not found.",
                });
                return;
              }

              await pkg.updateStatus(
                "failed_delivery_attempt",
                deliverer.userId,
                pkg.currentBranchId,
                data.reason,
              );
              const updatedPkgAfterFail =
                await PackageModel.findById(packageId).lean();
              const attemptsExhausted =
                (updatedPkgAfterFail?.attemptCount ?? 0) >=
                (updatedPkgAfterFail?.maxAttempts ?? 3);
              await PaymentModel.findOneAndUpdate(
                { packageId },
                {
                  $set: {
                    status: attemptsExhausted ? "failed" : "pending",
                    delivererId: deliverer.userId,
                  },
                },
              );
              if (data.issueType)
                await pkg.addIssue(
                  data.issueType,
                  data.reason,
                  deliverer.userId,
                  "medium",
                );
              this.deliveryOTPs.delete(`delivery_otp_${packageId}`);
              await route.failStop(data.stopIndex, data.reason, [
                new mongoose.Types.ObjectId(packageId),
              ]);
              await DelivererModel.findByIdAndUpdate(deliverer._id, {
                $inc: { totalDeliveries: 1, failedDeliveries: 1 },
                lastActiveAt: new Date(),
              });

              const updatedPkg = await PackageModel.findById(packageId).lean();
              const attemptsLeft =
                (updatedPkg?.maxAttempts ?? 3) -
                (updatedPkg?.attemptCount ?? 0);
              const maxReached =
                (updatedPkg?.attemptCount ?? 0) >=
                (updatedPkg?.maxAttempts ?? 3);
              const routeRoom = this.getRouteRoom(data.routeId);

              let requeuedStopIndex: number | null = null;
              if (!maxReached) {
                route.stops.push({
                  clientId: stop.clientId,
                  location: stop.location,
                  address: stop.address,
                  packageIds: stop.packageIds,
                  action: stop.action,
                  status: "pending" as const,
                  order: route.stops.length + 1,
                  ...(stop.branchId ? { branchId: stop.branchId } : {}),
                } as any);
                await route.save();
                requeuedStopIndex = route.stops.length - 1;
              }

              this.io
                .to(this.getPackageRoom(packageId))
                .emit("package_delivery_failed", {
                  packageId,
                  attemptCount: updatedPkg?.attemptCount,
                  maxAttempts: updatedPkg?.maxAttempts,
                  attemptsLeft,
                  nextAttemptDate: updatedPkg?.nextAttemptDate,
                  requeuedAtStop: requeuedStopIndex,
                  reason: data.reason,
                  message: maxReached
                    ? "All delivery attempts exhausted. Package will be returned."
                    : `Delivery attempt failed. Deliverer will retry after remaining stops.`,
                  timestamp: new Date(),
                });
              this.io
                .to(this.getBranchRoom(deliverer.branchId.toString()))
                .emit("deliverer_delivery_failed", {
                  routeId: data.routeId,
                  delivererId: deliverer._id,
                  stopIndex: data.stopIndex,
                  packageId,
                  attemptCount: updatedPkg?.attemptCount,
                  maxAttempts: updatedPkg?.maxAttempts,
                  maxReached,
                  requeuedAtStop: requeuedStopIndex,
                  reason: data.reason,
                  timestamp: new Date(),
                });

              const totalStopsNow = route.stops.length;
              const hasNextStop = route.currentStopIndex < totalStopsNow;
              const nextStop = hasNextStop
                ? route.stops[route.currentStopIndex]
                : null;
              const isNowTrulyLastStop = !hasNextStop;

              const failPayload = this.buildFailedStopPayload(
                data.routeId,
                data.stopIndex,
                packageId,
                data.reason,
                updatedPkg,
                distanceMeters,
              );

              if (maxReached) {
                this.io
                  .to(this.getBranchRoom(deliverer.branchId.toString()))
                  .emit("package_requires_return", {
                    packageId,
                    trackingNumber: updatedPkg?.trackingNumber,
                    delivererId: deliverer._id,
                    attemptCount: updatedPkg?.attemptCount,
                    reason: data.reason,
                    timestamp: new Date(),
                  });
                if (isNowTrulyLastStop) {
                  await route.completeRoute(
                    `Last stop failed (max attempts): ${data.reason}`,
                  );
                  socket.emit("delivery_route_completed", {
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    status: "completed",
                    hasPackagesToReturn: true,
                    message:
                      "Route finished. Please return the failed package to your branch.",
                    timestamp: new Date(),
                  });
                } else {
                  if (nextStop)
                    await this.generateAndSendDeliveryOTP(
                      route,
                      route.currentStopIndex,
                      data.routeId,
                    );
                  socket.emit("delivery_attempt_failed", {
                    ...failPayload,
                    maxReached: true,
                    requiresReturn: true,
                    requeuedAtStop: null,
                    nextStop: nextStop
                      ? {
                          stopIndex: route.currentStopIndex,
                          stopId: nextStop._id,
                          clientId: nextStop.clientId,
                          packageId: nextStop.packageIds[0],
                          address: nextStop.address,
                          location: nextStop.location.coordinates,
                          otpSent: true,
                        }
                      : null,
                    remainingStops: totalStopsNow - route.currentStopIndex,
                    message:
                      "Maximum attempts reached. Package will be returned. Continuing to next stop.",
                    timestamp: new Date(),
                  });
                  this.io.to(routeRoom).emit("delivery_stop_failed", {
                    routeId: data.routeId,
                    stopIndex: data.stopIndex,
                    packageId,
                    reason: data.reason,
                    timestamp: new Date(),
                  });
                }
              } else {
                if (nextStop)
                  await this.generateAndSendDeliveryOTP(
                    route,
                    route.currentStopIndex,
                    data.routeId,
                  );
                socket.emit("delivery_attempt_failed", {
                  ...failPayload,
                  maxReached: false,
                  requiresReturn: false,
                  requeuedAtStop: requeuedStopIndex,
                  nextStop: nextStop
                    ? {
                        stopIndex: route.currentStopIndex,
                        stopId: nextStop._id,
                        clientId: nextStop.clientId,
                        packageId: nextStop.packageIds[0],
                        address: nextStop.address,
                        location: nextStop.location.coordinates,
                        isRetry: route.currentStopIndex === requeuedStopIndex,
                        otpSent: true,
                      }
                    : null,
                  remainingStops: totalStopsNow - route.currentStopIndex,
                  message: nextStop
                    ? `Attempt recorded. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining.`
                    : "All stops complete.",
                  timestamp: new Date(),
                });
                this.io.to(routeRoom).emit("delivery_stop_failed", {
                  routeId: data.routeId,
                  stopIndex: data.stopIndex,
                  packageId,
                  requeuedAtStop: requeuedStopIndex,
                  reason: data.reason,
                  timestamp: new Date(),
                });
              }

              console.log(
                `[Socket] Deliverer ${userId} failed delivery stop ${data.stopIndex}. ` +
                  `Attempts: ${updatedPkg?.attemptCount}/${updatedPkg?.maxAttempts}. ` +
                  (maxReached
                    ? "Max reached."
                    : `Requeued at stop ${requeuedStopIndex}.`),
              );
            } catch (err: any) {
              socket.emit("route_error", {
                code: "FAIL_DELIVERY_FAILED",
                message: err.message || "Failed to record delivery failure.",
              });
            }
          },
        );

        socket.on(
          "resend_delivery_otp",
          async (data: { routeId: string; stopIndex: number }) => {
            try {
              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) return;
              const route = await RouteModel.findOne({
                _id: data?.routeId,
                assignedDelivererId: deliverer._id,
                status: "active",
              }).lean();
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                return;
              }
              if (data.stopIndex !== route.currentStopIndex) {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: "Can only resend OTP for current stop.",
                });
                return;
              }
              const stop = route.stops[data.stopIndex];
              if (!stop?.packageIds[0]) {
                socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop or package not found.",
                });
                return;
              }
              this.deliveryOTPs.delete(
                `delivery_otp_${stop.packageIds[0].toString()}`,
              );
              await this.generateAndSendDeliveryOTP(
                route as any,
                data.stopIndex,
                data.routeId,
              );
              socket.emit("delivery_otp_resent", {
                routeId: data.routeId,
                stopIndex: data.stopIndex,
                packageId: stop.packageIds[0],
                message: "New OTP sent to client.",
                timestamp: new Date(),
              });
            } catch (err: any) {
              socket.emit("route_error", {
                code: "RESEND_OTP_FAILED",
                message: "Failed to resend OTP.",
              });
            }
          },
        );

        socket.on(
          "return_package_to_branch",
          async (data: {
            packageId: string;
            branchId: string;
            coordinates: [number, number];
            notes?: string;
          }) => {
            try {
              if (!data?.packageId || !data?.branchId) {
                socket.emit("route_error", {
                  code: "MISSING_DATA",
                  message: "packageId and branchId required.",
                });
                return;
              }
              if (!data?.coordinates || data.coordinates.length !== 2) {
                socket.emit("route_error", {
                  code: "NO_COORDINATES",
                  message: "Coordinates required.",
                });
                return;
              }
              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                return;
              }
              const pkg = await PackageModel.findOne({
                _id: data.packageId,
                assignedDelivererId: deliverer._id,
              });
              if (!pkg) {
                socket.emit("route_error", {
                  code: "PACKAGE_NOT_FOUND",
                  message: "Package not found.",
                });
                return;
              }
              const BranchModel = (await import("../models/branch.model"))
                .default;
              const branch = await BranchModel.findById(data.branchId)
                .select("location name")
                .lean();
              if (!branch || !(branch as any).location) {
                socket.emit("route_error", {
                  code: "BRANCH_NOT_FOUND",
                  message: "Branch location unavailable.",
                });
                return;
              }
              const branchCoords = (branch as any).location.coordinates as [
                number,
                number,
              ];
              const distanceMeters =
                this.calculateDistance(data.coordinates, branchCoords) * 1000;
              if (distanceMeters > 50) {
                socket.emit("route_error", {
                  code: "TOO_FAR",
                  message: `Must be at branch within 50m. Current: ${Math.round(distanceMeters)}m.`,
                  distanceMeters: Math.round(distanceMeters),
                  requiredMeters: 50,
                });
                return;
              }
              if (pkg.status !== "returned") {
                await pkg.initiateReturn(
                  "Maximum delivery attempts exceeded",
                  undefined,
                  data.notes,
                );
              } else {
                pkg.trackingHistory.push({
                  status: "returned",
                  branchId: new mongoose.Types.ObjectId(data.branchId),
                  userId: deliverer.userId,
                  notes: data.notes || "Package returned to branch",
                  timestamp: new Date(),
                } as any);
                await pkg.save();
              }
              await DelivererModel.findByIdAndUpdate(deliverer._id, {
                availabilityStatus: "available",
                currentRouteId: null,
                lastActiveAt: new Date(),
              });
              this.io
                .to(this.getBranchRoom(data.branchId))
                .emit("package_returned_to_branch", {
                  packageId: data.packageId,
                  trackingNumber: pkg.trackingNumber,
                  delivererId: deliverer._id,
                  branchId: data.branchId,
                  notes: data.notes,
                  timestamp: new Date(),
                });
              this.io
                .to(this.getPackageRoom(data.packageId))
                .emit("package_status_update", {
                  packageId: data.packageId,
                  status: "returned",
                  message:
                    "Package returned to branch after failed delivery attempts.",
                  timestamp: new Date(),
                });
              socket.emit("return_confirmed", {
                packageId: data.packageId,
                trackingNumber: pkg.trackingNumber,
                branchId: data.branchId,
                distanceMeters: Math.round(distanceMeters),
                message:
                  "Return confirmed. You are now available for a new route.",
                timestamp: new Date(),
              });
              console.log(
                `[Socket] Deliverer ${userId} returned package ${data.packageId} to branch ${data.branchId}`,
              );
            } catch (err: any) {
              socket.emit("route_error", {
                code: "RETURN_FAILED",
                message: err.message || "Failed to confirm return.",
              });
            }
          },
        );

        socket.on(
          "join_delivery_route_room",
          async (data: { routeId: string }) => {
            if (!data?.routeId) return;
            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) return;
            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedDelivererId: deliverer._id,
              status: { $in: ["active", "paused"] },
            }).lean();
            if (!route) {
              socket.emit("route_error", {
                code: "ROUTE_NOT_FOUND",
                message: "No active/paused route found.",
              });
              return;
            }
            socket.join(this.getRouteRoom(data.routeId));
            const currentStop = route.stops[route.currentStopIndex];
            socket.emit("delivery_route_rejoined", {
              routeId: data.routeId,
              routeNumber: route.routeNumber,
              status: route.status,
              currentStopIndex: route.currentStopIndex,
              totalStops: route.stops.length,
              completedStops: route.completedStops,
              currentStop: currentStop
                ? {
                    stopId: currentStop._id,
                    clientId: currentStop.clientId,
                    packageId: currentStop.packageIds[0],
                    address: currentStop.address,
                    location: currentStop.location.coordinates,
                    status: currentStop.status,
                  }
                : null,
              timestamp: new Date(),
            });
          },
        );
      } // end if (role === "deliverer")

      // ══════════════════════════════════════════════════════════════════════
      //  PACKAGE / MANIFEST TRACKING
      // ══════════════════════════════════════════════════════════════════════

      socket.on("track_package", async (data: { packageId: string }) => {
        try {
          if (!data?.packageId) {
            socket.emit("track_package_error", {
              message: "packageId required.",
            });
            return;
          }
          const pkg = await PackageModel.findById(data.packageId).lean();
          if (!pkg) {
            socket.emit("track_package_error", {
              message: "Package not found.",
            });
            return;
          }
          const isAuthorized =
            role === "admin" ||
            role === "manager" ||
            role === "supervisor" ||
            pkg.senderId?.toString() === userId ||
            (role === "deliverer" &&
              (pkg as any).assignedDelivererId?.toString() === userId) ||
            (role === "transporter" &&
              (pkg as any).assignedTransporterId?.toString() === userId);
          if (!isAuthorized) {
            socket.emit("track_package_error", { message: "Not authorized." });
            return;
          }
          socket.join(this.getPackageRoom(data.packageId));
          socket.emit("package_status_update", {
            packageId: data.packageId,
            status: pkg.status,
            currentBranchId: pkg.currentBranchId,
            assignedDelivererId: pkg.assignedDelivererId,
            assignedTransporterId: pkg.assignedTransporterId,
            estimatedDeliveryTime: pkg.estimatedDeliveryTime,
            trackingHistory: pkg.trackingHistory,
            timestamp: new Date(),
          });
        } catch (error: any) {
          socket.emit("track_package_error", {
            message: "Failed to subscribe.",
            error: error.message,
          });
        }
      });

      socket.on("untrack_package", (data: { packageId: string }) => {
        if (!data?.packageId) return;
        socket.leave(this.getPackageRoom(data.packageId));
      });

      socket.on("track_manifest", async (data: { manifestId: string }) => {
        try {
          if (
            !data?.manifestId ||
            !mongoose.Types.ObjectId.isValid(data.manifestId)
          ) {
            socket.emit("track_manifest_error", {
              message: "Valid manifestId required.",
            });
            return;
          }
          const allowed = ["admin", "manager", "supervisor", "transporter"];
          if (!allowed.includes(role)) {
            socket.emit("track_manifest_error", { message: "Not authorized." });
            return;
          }
          const manifest = await ManifestModel.findById(data.manifestId)
            .select(
              "manifestCode status originBranchId destinationBranchId totalDeclaredWeight packageCount transportLeg",
            )
            .lean();
          if (!manifest) {
            socket.emit("track_manifest_error", {
              message: "Manifest not found.",
            });
            return;
          }
          socket.join(this.getManifestRoom(data.manifestId));
          socket.emit("manifest_status_update", {
            manifestId: data.manifestId,
            manifestCode: manifest.manifestCode,
            status: manifest.status,
            originBranchId: manifest.originBranchId,
            destinationBranchId: manifest.destinationBranchId,
            packageCount: manifest.packageCount,
            totalWeight: manifest.totalDeclaredWeight,
            departedAt: manifest.transportLeg?.departedAt,
            arrivedAt: manifest.transportLeg?.arrivedAt,
            timestamp: new Date(),
          });
        } catch (err: any) {
          socket.emit("track_manifest_error", { message: err.message });
        }
      });

      socket.on("untrack_manifest", (data: { manifestId: string }) => {
        if (!data?.manifestId) return;
        socket.leave(this.getManifestRoom(data.manifestId));
      });

      // ══════════════════════════════════════════════════════════════════════
      //  BRANCH ROOM MANAGEMENT  (supervisor / manager / admin)
      // ══════════════════════════════════════════════════════════════════════

      if (role === "supervisor" || role === "manager" || role === "admin") {
        socket.on("join_branch_room", (data: { branchId: string }) => {
          if (!data?.branchId) return;
          const room = this.getBranchRoom(data.branchId);
          socket.join(room);
          socket.emit("joined_branch_room", { branchId: data.branchId, room });
        });
        socket.on("leave_branch_room", (data: { branchId: string }) => {
          if (!data?.branchId) return;
          socket.leave(this.getBranchRoom(data.branchId));
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      //  DISCONNECT
      // ══════════════════════════════════════════════════════════════════════

      socket.on("disconnect", async (reason) => {
        console.log(
          `[Socket] Disconnected: userId=${userId} role=${role} reason=${reason}`,
        );
        this.unregisterSocket(userId, role);

        if (role === "deliverer" || role === "transporter") {
          const timer = setTimeout(async () => {
            this.disconnectTimers.delete(userId);
            try {
              if (role === "deliverer") {
                await DelivererModel.findOneAndUpdate(
                  { userId },
                  { isOnline: false, lastActiveAt: new Date() },
                );
                await this.broadcastOnlineStatus(userId, role, false);
                await this.notifyDelivererOfflineToTrackers(userId);
              } else {
                await TransporterModel.findOneAndUpdate(
                  { userId },
                  { isOnline: false, lastActiveAt: new Date() },
                );
                await this.broadcastOnlineStatus(userId, role, false);
                await this.notifyTransporterOfflineToBranch(userId);
              }
              await PresenceService.setOffline(userId, role).catch((e: any) =>
                console.error(
                  "[Socket] PresenceService.setOffline:",
                  e.message,
                ),
              );
            } catch (err) {
              console.error("[Socket] Disconnect cleanup error:", err);
            }
          }, 30000);
          this.disconnectTimers.set(userId, timer);
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private async joinRoleRooms(
    socket: AuthenticatedSocket,
    userId: string,
    role: DeliveryUserRole,
  ): Promise<void> {
    try {
      if (role === "deliverer") {
        const d = await DelivererModel.findOne({ userId }).lean();
        if (d) {
          socket.join(this.getBranchRoom(d.branchId.toString()));
          socket.join(this.getCompanyRoom(d.companyId.toString()));
        }
      } else if (role === "transporter") {
        const t = await TransporterModel.findOne({ userId }).lean();
        if (t) {
          socket.join(this.getCompanyRoom(t.companyId.toString()));
          if (t.currentBranchId)
            socket.join(this.getBranchRoom(t.currentBranchId.toString()));
        }
      } else if (role === "supervisor") {
        const s = await SupervisorModel.findOne({ userId })
          .select("branchId companyId")
          .lean();
        if (s) {
          socket.join(this.getBranchRoom(s.branchId.toString()));
          socket.join(this.getCompanyRoom(s.companyId.toString()));
        }
      } else if (role === "freelancer") {
        const f = await FreelancerModel.findOne({ userId })
          .select("companyId defaultOriginBranchId")
          .lean();
        if (f) {
          socket.join(this.getCompanyRoom(f.companyId.toString()));
          if (f.defaultOriginBranchId)
            socket.join(this.getBranchRoom(f.defaultOriginBranchId.toString()));
        }
      }
    } catch (err) {
      console.error("[Socket] joinRoleRooms error:", err);
    }
  }

  private registerSocket(
    userId: string,
    role: DeliveryUserRole,
    socketId: string,
  ): void {
    const map = this.socketMapFor(role);
    if (map) map.set(userId, socketId);
  }

  private unregisterSocket(userId: string, role: DeliveryUserRole): void {
    const map = this.socketMapFor(role);
    if (map) map.delete(userId);
  }

  private socketMapFor(role: DeliveryUserRole): Map<string, string> | null {
    switch (role) {
      case "deliverer":
        return this.delivererSockets;
      case "transporter":
        return this.transporterSockets;
      case "client":
        return this.clientSockets;
      case "freelancer":
        return this.freelancerSockets;
      case "supervisor":
        return this.supervisorSockets;
      case "manager":
        return this.managerSockets;
      case "admin":
        return this.adminSockets;
      default:
        return null;
    }
  }

  private async broadcastOnlineStatus(
    userId: string,
    role: DeliveryUserRole,
    isOnline: boolean,
  ): Promise<void> {
    try {
      if (role === "deliverer") {
        const d = await DelivererModel.findOne({ userId }).lean();
        if (!d) return;
        this.io
          .to(this.getBranchRoom(d.branchId.toString()))
          .emit(isOnline ? "deliverer_online" : "deliverer_offline", {
            userId,
            delivererId: d._id,
            branchId: d.branchId,
            availabilityStatus: d.availabilityStatus,
            timestamp: new Date(),
          });
      } else if (role === "transporter") {
        const t = await TransporterModel.findOne({ userId }).lean();
        if (!t) return;
        this.io
          .to(this.getCompanyRoom(t.companyId.toString()))
          .emit(isOnline ? "transporter_online" : "transporter_offline", {
            userId,
            transporterId: t._id,
            companyId: t.companyId,
            availabilityStatus: t.availabilityStatus,
            timestamp: new Date(),
          });
      }
    } catch (err) {
      console.error("[Socket] broadcastOnlineStatus error:", err);
    }
  }

  private async broadcastDelivererLocation(
    delivererUserId: string,
    coordinates: [number, number],
  ): Promise<void> {
    try {
      const packages = await PackageModel.find({
        assignedDelivererId: delivererUserId,
        status: "out_for_delivery",
      })
        .select("_id")
        .lean();
      for (const pkg of packages) {
        this.io
          .to(this.getPackageRoom(pkg._id.toString()))
          .emit("deliverer_location_update", {
            packageId: pkg._id,
            delivererId: delivererUserId,
            coordinates,
            timestamp: new Date(),
          });
      }
    } catch (err) {
      console.error("[Socket] broadcastDelivererLocation error:", err);
    }
  }

  private async broadcastTransporterLocation(
    transporterUserId: string,
    coordinates: [number, number],
  ): Promise<void> {
    try {
      const transporter = await TransporterModel.findOne({
        userId: transporterUserId,
      })
        .select("companyId currentBranchId currentRouteId _id")
        .lean();
      if (!transporter) return;

      if (transporter.currentBranchId) {
        this.io
          .to(this.getBranchRoom(transporter.currentBranchId.toString()))
          .emit("transporter_location_update", {
            transporterId: transporter._id,
            userId: transporterUserId,
            coordinates,
            timestamp: new Date(),
          });
      }

      const packages = await PackageModel.find({
        assignedTransporterId: transporterUserId,
        status: "in_transit_to_branch",
      })
        .select("_id")
        .lean();
      for (const pkg of packages) {
        this.io
          .to(this.getPackageRoom(pkg._id.toString()))
          .emit("transporter_location_update", {
            packageId: pkg._id,
            transporterId: transporter._id,
            coordinates,
            timestamp: new Date(),
          });
      }

      const manifests = await ManifestModel.find({
        "transportLeg.transporterId": transporter._id,
        status: "in_transit",
      })
        .select("_id manifestCode")
        .lean();
      for (const m of manifests) {
        this.io
          .to(this.getManifestRoom(m._id.toString()))
          .emit("transporter_location_update", {
            manifestId: m._id,
            manifestCode: m.manifestCode,
            transporterId: transporter._id,
            coordinates,
            timestamp: new Date(),
          });
      }
    } catch (err) {
      console.error("[Socket] broadcastTransporterLocation error:", err);
    }
  }

  private async notifyDelivererStatusToTrackers(
    delivererUserId: string,
    status: string,
  ): Promise<void> {
    try {
      const packages = await PackageModel.find({
        assignedDelivererId: delivererUserId,
        status: { $in: ["out_for_delivery", "at_destination_branch"] },
      })
        .select("_id")
        .lean();
      for (const pkg of packages) {
        this.io
          .to(this.getPackageRoom(pkg._id.toString()))
          .emit("deliverer_status_update", {
            packageId: pkg._id,
            delivererId: delivererUserId,
            availabilityStatus: status,
            timestamp: new Date(),
          });
      }
    } catch (err) {
      console.error("[Socket] notifyDelivererStatusToTrackers error:", err);
    }
  }

  private async notifyDelivererOfflineToTrackers(
    delivererUserId: string,
  ): Promise<void> {
    try {
      const packages = await PackageModel.find({
        assignedDelivererId: delivererUserId,
        status: "out_for_delivery",
      })
        .select("_id")
        .lean();
      for (const pkg of packages) {
        this.io
          .to(this.getPackageRoom(pkg._id.toString()))
          .emit("deliverer_offline", {
            packageId: pkg._id,
            delivererId: delivererUserId,
            message: "Deliverer temporarily offline.",
            timestamp: new Date(),
          });
      }
    } catch (err) {
      console.error("[Socket] notifyDelivererOfflineToTrackers error:", err);
    }
  }

  private async notifyTransporterOfflineToBranch(
    transporterUserId: string,
  ): Promise<void> {
    try {
      const t = await TransporterModel.findOne({ userId: transporterUserId })
        .select("currentBranchId companyId")
        .lean();
      if (!t) return;
      const target = t.currentBranchId
        ? this.getBranchRoom(t.currentBranchId.toString())
        : this.getCompanyRoom(t.companyId.toString());
      this.io.to(target).emit("transporter_offline", {
        transporterId: t._id,
        userId: transporterUserId,
        message: "Transporter temporarily offline.",
        timestamp: new Date(),
      });
    } catch (err) {
      console.error("[Socket] notifyTransporterOfflineToBranch error:", err);
    }
  }

  private async generateAndSendDeliveryOTP(
    route: any,
    stopIndex: number,
    routeId: string,
  ): Promise<void> {
    try {
      const stop = route.stops[stopIndex];
      if (!stop || !stop.packageIds[0]) return;
      const packageId = stop.packageIds[0].toString();
      const pkg = await PackageModel.findById(packageId)
        .select("destination trackingNumber")
        .lean();
      if (!pkg) return;
      const recipientPhone = (pkg as any).destination?.recipientPhone;
      if (!recipientPhone) {
        console.warn(`[OTP] No phone for package ${packageId}`);
        return;
      }
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 10 * 60 * 1000;
      this.deliveryOTPs.set(`delivery_otp_${packageId}`, { code, expiresAt });
      await PackageModel.findByIdAndUpdate(packageId, {
        $set: {
          "deliveryOtp.code": code,
          "deliveryOtp.expiresAt": new Date(expiresAt),
          "deliveryOtp.stopIndex": stopIndex,
          "deliveryOtp.routeId": new mongoose.Types.ObjectId(routeId),
          "deliveryOtp.generatedAt": new Date(),
          "deliveryOtp.verified": false,
        },
      });
      const smsSent = await sendSMS({
        to: recipientPhone,
        message: `Your delivery code for package ${(pkg as any).trackingNumber} is: ${code}. Valid for 10 minutes.`,
      });
      if (!smsSent) console.error(`[OTP] SMS failed for ${packageId}`);
    } catch (err) {
      console.error("[Socket] generateAndSendDeliveryOTP error:", err);
    }
  }

  private buildFailedStopPayload(
    routeId: string,
    stopIndex: number,
    packageId: string,
    reason: string,
    pkg: any,
    distanceMeters: number,
  ): Record<string, any> {
    const attemptsLeft = (pkg?.maxAttempts ?? 3) - (pkg?.attemptCount ?? 0);
    return {
      routeId,
      stopIndex,
      packageId,
      attemptCount: pkg?.attemptCount,
      maxAttempts: pkg?.maxAttempts,
      attemptsLeft,
      maxReached: (pkg?.attemptCount ?? 0) >= (pkg?.maxAttempts ?? 3),
      requiresReturn: (pkg?.attemptCount ?? 0) >= (pkg?.maxAttempts ?? 3),
      nextAttemptDate: pkg?.nextAttemptDate,
      distanceMeters: Math.round(distanceMeters),
      reason,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECONNECT RESUME
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  Called on every (re)connection for deliverer and transporter roles.
  //  Queries the DB for any unfinished work and emits a single
  //  "session_resumed" event so the frontend can restore its UI state without
  //  the user having to navigate back manually.
  //
  //  Deliverer  → finds the active/paused delivery route and its current stop.
  //               Includes the first non-completed package at that stop plus
  //               whether an OTP is still alive for it.
  //
  //  Transporter → finds the active/paused hub or non-hub route, the current
  //                stop, and the manifests (hub routes) or packages (other
  //                routes) that are still in transit at that stop.
  //                Also re-attaches the socket to the route room so subsequent
  //                stop events work without the user pressing "rejoin".
  //
  //  If nothing is unfinished the event is NOT emitted (no unnecessary noise).
  // ─────────────────────────────────────────────────────────────────────────

  private async resumeActiveSession(
    socket: AuthenticatedSocket,
    userId: string,
    role: "deliverer" | "transporter",
  ): Promise<void> {
    try {
      if (role === "deliverer") {
        await this.resumeDelivererSession(socket, userId);
      } else {
        await this.resumeTransporterSession(socket, userId);
      }
    } catch (err: any) {
      // Non-fatal — just log. Never throw back to the connection handler.
      console.error(
        `[Socket] resumeActiveSession failed for ${role} ${userId}:`,
        err.message,
      );
    }
  }

  // ── Deliverer ──────────────────────────────────────────────────────────────

  private async resumeDelivererSession(
    socket: AuthenticatedSocket,
    userId: string,
  ): Promise<void> {
    const deliverer = await DelivererModel.findOne({ userId })
      .select("_id branchId companyId")
      .lean();
    if (!deliverer) return;

    const route = await RouteModel.findOne({
      assignedDelivererId: deliverer._id,
      status: { $in: ["active", "paused"] },
    }).lean();
    if (!route) return;

    // currentStopIndex is the source of truth — completeStop() and failStop()
    // both increment it, so this always points at the stop needing action.
    const stop = route.stops[route.currentStopIndex];
    if (!stop) return;

    // First package at this stop not yet in completed / failed / skipped.
    // Each stop normally has exactly one package; requeued stops also have one
    // (the same package re-appended as a fresh stop at the end of the array).
    const resolvedAtStop = new Set([
      ...stop.completedPackages.map(String),
      ...stop.failedPackages.map(String),
      ...stop.skippedPackages.map(String),
    ]);
    const activePackageId =
      stop.packageIds.find((id) => !resolvedAtStop.has(id.toString())) ?? null;
    if (!activePackageId) return;

    // ── Fetch package document ────────────────────────────────────────────────
    const pkg = await PackageModel.findById(activePackageId)
      .select(
        "trackingNumber status destination attemptCount maxAttempts estimatedDeliveryTime deliveryOtp",
      )
      .lean();

    // ── OTP restoration ───────────────────────────────────────────────────────
    // In-memory map is wiped on server restart; fall back to the persisted
    // package.deliveryOtp field and restore to memory so complete_delivery
    // works without the deliverer having to request a fresh code.
    const otpKey = `delivery_otp_${activePackageId.toString()}`;
    const memEntry = this.deliveryOTPs.get(otpKey);
    const dbOtp = pkg?.deliveryOtp;

    const otpAlive =
      (!!memEntry && Date.now() < memEntry.expiresAt) ||
      (!memEntry &&
        !!dbOtp?.code &&
        !dbOtp.verified &&
        dbOtp.expiresAt > new Date());

    if (!memEntry && otpAlive && dbOtp?.code) {
      this.deliveryOTPs.set(otpKey, {
        code: dbOtp.code,
        expiresAt: dbOtp.expiresAt.getTime(),
      });
    }

    // ── Re-join route room ────────────────────────────────────────────────────
    socket.join(this.getRouteRoom(route._id.toString()));

    socket.emit("session_resumed", {
      role: "deliverer",
      routeId: route._id,
      routeNumber: route.routeNumber,
      routeType: route.type,
      routeStatus: route.status,
      currentStopIndex: route.currentStopIndex,
      totalStops: route.stops.length,
      completedStops: route.completedStops,
      remainingStops: route.stops.length - route.currentStopIndex,
      scheduledEnd: route.scheduledEnd,
      actualStart: route.actualStart,
      isDelayed: route.scheduledEnd ? new Date() > route.scheduledEnd : false,

      currentStop: {
        stopId: stop._id,
        stopIndex: route.currentStopIndex,
        status: stop.status,
        address: stop.address,
        location: stop.location.coordinates,
        clientId: stop.clientId,
        action: stop.action,
        packageIds: stop.packageIds,
        activePackageId,
      },

      activePackage: pkg
        ? {
            packageId: pkg._id,
            trackingNumber: pkg.trackingNumber,
            status: pkg.status,
            recipientName: pkg.destination?.recipientName,
            recipientPhone: pkg.destination?.recipientPhone,
            address: pkg.destination?.address,
            city: pkg.destination?.city,
            attemptCount: pkg.attemptCount,
            maxAttempts: pkg.maxAttempts,
            estimatedDeliveryTime: pkg.estimatedDeliveryTime,
            otp: {
              alive: otpAlive,
              expiresAt: memEntry
                ? new Date(memEntry.expiresAt)
                : (dbOtp?.expiresAt ?? null),
              verified: dbOtp?.verified ?? false,
            },
          }
        : null,

      message:
        route.status === "paused"
          ? "Your route was paused. Tap Resume to continue."
          : "You have an active delivery. Pick up where you left off.",
      timestamp: new Date(),
    });

    console.log(
      `[Socket] Deliverer ${userId} resumed — route ${route.routeNumber} ` +
        `stop ${route.currentStopIndex}/${route.stops.length - 1} ` +
        `pkg ${activePackageId} otpAlive=${otpAlive}`,
    );
  }

  // ── Transporter ────────────────────────────────────────────────────────────

  private async resumeTransporterSession(
    socket: AuthenticatedSocket,
    userId: string,
  ): Promise<void> {
    const transporter = await TransporterModel.findOne({ userId })
      .select("_id companyId currentBranchId")
      .lean();
    if (!transporter) return;

    const route = await RouteModel.findOne({
      assignedTransporterId: transporter._id,
      status: { $in: ["active", "paused"] },
    }).lean();
    if (!route) return;

    // currentStopIndex is the source of truth — same as deliverer logic.
    const hubRoute = isHubRoute(route.type);
    const stop = route.stops[route.currentStopIndex];
    if (!stop) return;

    // ── Pending manifests at this stop (hub routes) ───────────────────────────
    // Manifests not yet in completedManifests or discrepancyManifests
    // are still physically on the truck and need to be handed over.
    let pendingManifests: any[] = [];
    if (hubRoute) {
      const doneSet = new Set([
        ...stop.completedManifests.map(String),
        ...stop.discrepancyManifests.map(String),
      ]);
      const pendingIds = (stop.manifestIds ?? []).filter(
        (id) => !doneSet.has(id.toString()),
      );
      if (pendingIds.length > 0) {
        pendingManifests = await ManifestModel.find({
          _id: { $in: pendingIds },
        })
          .select(
            "_id manifestCode status packageCount totalDeclaredWeight originBranchId destinationBranchId",
          )
          .lean();
      }
    }

    // ── Pending packages at this stop (non-hub routes) ────────────────────────
    // Packages not yet in completedPackages / failedPackages / skippedPackages.
    let pendingPackages: any[] = [];
    if (!hubRoute) {
      const doneSet = new Set([
        ...stop.completedPackages.map(String),
        ...stop.failedPackages.map(String),
        ...stop.skippedPackages.map(String),
      ]);
      const pendingIds = stop.packageIds.filter(
        (id) => !doneSet.has(id.toString()),
      );
      if (pendingIds.length > 0) {
        pendingPackages = await PackageModel.find({ _id: { $in: pendingIds } })
          .select("_id trackingNumber status destination currentBranchId")
          .lean();
      }
    }

    // ── Live QR session check (hub routes only) ───────────────────────────────
    // If request_stop_qr was called before disconnect but scan_stop_qr was not,
    // the session is still valid and the branch QR is still on screen.
    // We return the code so the transporter app can go straight to "scan now".
    let pendingQrSession: any = null;
    if (hubRoute) {
      const qr = await StopQrSessionModel.findOne({
        routeId: route._id,
        stopIndex: route.currentStopIndex,
        verified: false,
        expiresAt: { $gt: new Date() },
      })
        .select("_id code expiresAt manifestCount isLastStop")
        .lean();

      if (qr) {
        pendingQrSession = {
          sessionId: qr._id,
          qrCode: qr.code,
          expiresAt: qr.expiresAt,
          manifestCount: qr.manifestCount,
          isLastStop: qr.isLastStop,
        };
      }
    }

    // ── Re-join route room ────────────────────────────────────────────────────
    socket.join(this.getRouteRoom(route._id.toString()));

    const nextStop = route.stops[route.currentStopIndex + 1] ?? null;

    socket.emit("session_resumed", {
      role: "transporter",
      routeId: route._id,
      routeNumber: route.routeNumber,
      routeType: route.type,
      routeStatus: route.status,
      isHubRoute: hubRoute,
      currentStopIndex: route.currentStopIndex,
      totalStops: route.stops.length,
      completedStops: route.completedStops,
      remainingStops: route.stops.length - route.currentStopIndex,
      scheduledEnd: route.scheduledEnd,
      actualStart: route.actualStart,
      isDelayed: route.scheduledEnd ? new Date() > route.scheduledEnd : false,

      currentStop: {
        stopId: stop._id,
        stopIndex: route.currentStopIndex,
        status: stop.status,
        address: stop.address,
        location: stop.location.coordinates,
        branchId: stop.branchId,
        action: stop.action,
        isLastStop: route.currentStopIndex === route.stops.length - 1,

        // Hub routes: full manifest cards for everything still on the truck
        pendingManifestCount: pendingManifests.length,
        totalManifestCount: stop.manifestIds?.length ?? 0,
        pendingManifests: pendingManifests.map((m) => ({
          manifestId: m._id,
          manifestCode: m.manifestCode,
          status: m.status,
          packageCount: m.packageCount,
          totalWeight: m.totalDeclaredWeight,
          originBranchId: m.originBranchId,
          destinationBranchId: m.destinationBranchId,
        })),

        // Non-hub routes: package cards
        pendingPackageCount: pendingPackages.length,
        totalPackageCount: stop.packageIds.length,
        pendingPackages: pendingPackages.map((p) => ({
          packageId: p._id,
          trackingNumber: p.trackingNumber,
          status: p.status,
          recipientName: p.destination?.recipientName,
          city: p.destination?.city,
          currentBranchId: p.currentBranchId,
        })),
      },

      // Non-null only if request_stop_qr fired but scan_stop_qr did not yet —
      // frontend should restore the "scan now" screen immediately
      pendingQrSession,

      nextStop: nextStop
        ? {
            stopIndex: route.currentStopIndex + 1,
            stopId: nextStop._id,
            branchId: nextStop.branchId,
            address: nextStop.address,
            location: nextStop.location.coordinates,
            loadCount: stopLoadCount(nextStop, route.type),
            loadUnit: hubRoute ? "manifests" : "packages",
          }
        : null,

      message:
        route.status === "paused"
          ? "Your route was paused. Tap Resume to continue."
          : pendingQrSession
            ? "QR scan pending. Please scan the code at the branch to complete this stop."
            : "You have an active route. Pick up where you left off.",
      timestamp: new Date(),
    });

    console.log(
      `[Socket] Transporter ${userId} resumed — route ${route.routeNumber} ` +
        `(${route.type}) stop ${route.currentStopIndex}/${route.stops.length - 1} ` +
        `pending=${hubRoute ? pendingManifests.length + " manifests" : pendingPackages.length + " packages"} ` +
        `pendingQr=${!!pendingQrSession}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  public getSocketId(
    userId: string,
    role: DeliveryUserRole,
  ): string | undefined {
    return this.socketMapFor(role)?.get(userId);
  }

  public emitToUser(
    userId: string,
    role: DeliveryUserRole,
    event: string,
    data: any,
  ): void {
    const socketId = this.getSocketId(userId, role);
    if (socketId) this.io.to(socketId).emit(event, data);
  }

  public emitToBranch(branchId: string, event: string, data: any): void {
    this.io.to(this.getBranchRoom(branchId)).emit(event, data);
  }

  public emitToCompany(companyId: string, event: string, data: any): void {
    this.io.to(this.getCompanyRoom(companyId)).emit(event, data);
  }

  public emitPackageStatusUpdate(
    packageId: string,
    payload: {
      status: string;
      currentBranchId?: string;
      assignedDelivererId?: string;
      assignedTransporterId?: string;
      estimatedDeliveryTime?: Date;
      notes?: string;
    },
  ): void {
    this.io.to(this.getPackageRoom(packageId)).emit("package_status_update", {
      packageId,
      ...payload,
      timestamp: new Date(),
    });
  }

  public emitManifestStatusUpdate(
    manifestId: string,
    payload: {
      status: string;
      departedAt?: Date;
      arrivedAt?: Date;
      transporterId?: string;
    },
  ): void {
    this.io
      .to(this.getManifestRoom(manifestId))
      .emit("manifest_status_update", {
        manifestId,
        ...payload,
        timestamp: new Date(),
      });
  }

  public async startDeliverySession(
    packageId: string,
    delivererUserId: string,
    clientUserId?: string,
  ): Promise<void> {
    try {
      this.activeDeliveries.set(packageId, {
        packageId,
        delivererId: delivererUserId,
        clientId: clientUserId,
      });
      const sid = this.delivererSockets.get(delivererUserId);
      if (sid)
        this.io.sockets.sockets.get(sid)?.join(this.getPackageRoom(packageId));
      this.emitToUser(delivererUserId, "deliverer", "delivery_assigned", {
        packageId,
        timestamp: new Date(),
      });
      if (clientUserId)
        this.emitToUser(clientUserId, "client", "package_out_for_delivery", {
          packageId,
          delivererId: delivererUserId,
          message: "Your package is on the way!",
          timestamp: new Date(),
        });
    } catch (err) {
      console.error("[Socket] startDeliverySession error:", err);
    }
  }

  public async endDeliverySession(
    packageId: string,
    outcome: "delivered" | "failed_delivery" | "returned" | "rescheduled",
  ): Promise<void> {
    try {
      const session = this.activeDeliveries.get(packageId);
      this.io
        .to(this.getPackageRoom(packageId))
        .emit("delivery_session_ended", {
          packageId,
          outcome,
          timestamp: new Date(),
        });
      if (session) {
        const sid = this.delivererSockets.get(session.delivererId);
        if (sid)
          this.io.sockets.sockets
            .get(sid)
            ?.leave(this.getPackageRoom(packageId));
      }
      this.activeDeliveries.delete(packageId);
    } catch (err) {
      console.error("[Socket] endDeliverySession error:", err);
    }
  }

  public async startTransitSession(
    packageId: string,
    transporterUserId: string,
    originBranchId: string,
    destinationBranchId: string,
  ): Promise<void> {
    try {
      this.activeTransits.set(packageId, {
        packageId,
        transporterId: transporterUserId,
        originBranchId,
        destinationBranchId,
      });
      const sid = this.transporterSockets.get(transporterUserId);
      if (sid)
        this.io.sockets.sockets.get(sid)?.join(this.getPackageRoom(packageId));
      const payload = {
        packageId,
        transporterId: transporterUserId,
        originBranchId,
        destinationBranchId,
        timestamp: new Date(),
      };
      this.emitToBranch(originBranchId, "package_in_transit", payload);
      this.emitToBranch(destinationBranchId, "package_incoming", payload);
    } catch (err) {
      console.error("[Socket] startTransitSession error:", err);
    }
  }

  public async endTransitSession(packageId: string): Promise<void> {
    try {
      const session = this.activeTransits.get(packageId);
      this.io
        .to(this.getPackageRoom(packageId))
        .emit("transit_session_ended", { packageId, timestamp: new Date() });
      if (session) {
        this.emitToBranch(session.destinationBranchId, "package_arrived", {
          packageId,
          transporterId: session.transporterId,
          timestamp: new Date(),
        });
        const sid = this.transporterSockets.get(session.transporterId);
        if (sid)
          this.io.sockets.sockets
            .get(sid)
            ?.leave(this.getPackageRoom(packageId));
      }
      this.activeTransits.delete(packageId);
    } catch (err) {
      console.error("[Socket] endTransitSession error:", err);
    }
  }

  public async startManifestTransitSession(
    manifestId: string,
    manifestCode: string,
    transporterUserId: string,
    originBranchId: string,
    destinationBranchId: string,
  ): Promise<void> {
    try {
      this.activeManifestTransits.set(manifestId, {
        manifestId,
        manifestCode,
        transporterUserId,
        originBranchId,
        destinationBranchId,
      });
      const sid = this.transporterSockets.get(transporterUserId);
      if (sid)
        this.io.sockets.sockets
          .get(sid)
          ?.join(this.getManifestRoom(manifestId));
      const payload = {
        manifestId,
        manifestCode,
        transporterUserId,
        originBranchId,
        destinationBranchId,
        timestamp: new Date(),
      };
      this.emitToBranch(originBranchId, "manifest_in_transit", payload);
      this.emitToBranch(destinationBranchId, "manifest_incoming", payload);
    } catch (err) {
      console.error("[Socket] startManifestTransitSession error:", err);
    }
  }

  public async endManifestTransitSession(manifestId: string): Promise<void> {
    try {
      const session = this.activeManifestTransits.get(manifestId);
      this.io
        .to(this.getManifestRoom(manifestId))
        .emit("manifest_transit_ended", { manifestId, timestamp: new Date() });
      if (session) {
        this.emitToBranch(session.destinationBranchId, "manifest_arrived", {
          manifestId,
          manifestCode: session.manifestCode,
          transporterUserId: session.transporterUserId,
          timestamp: new Date(),
        });
        const sid = this.transporterSockets.get(session.transporterUserId);
        if (sid)
          this.io.sockets.sockets
            .get(sid)
            ?.leave(this.getManifestRoom(manifestId));
      }
      this.activeManifestTransits.delete(manifestId);
    } catch (err) {
      console.error("[Socket] endManifestTransitSession error:", err);
    }
  }

  public isUserOnline(userId: string, role: DeliveryUserRole): boolean {
    return !!this.getSocketId(userId, role);
  }

  public getConnectionStats(): Record<string, number> {
    return {
      deliverers: this.delivererSockets.size,
      transporters: this.transporterSockets.size,
      clients: this.clientSockets.size,
      freelancers: this.freelancerSockets.size,
      supervisors: this.supervisorSockets.size,
      managers: this.managerSockets.size,
      admins: this.adminSockets.size,
      total: [
        this.delivererSockets,
        this.transporterSockets,
        this.clientSockets,
        this.freelancerSockets,
        this.supervisorSockets,
        this.managerSockets,
        this.adminSockets,
      ].reduce((n, m) => n + m.size, 0),
    };
  }
}
