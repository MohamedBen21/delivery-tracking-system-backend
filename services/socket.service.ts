import { Server } from "socket.io";
import { AuthenticatedSocket } from "../middleware/socketAuth";
import mongoose from "mongoose";

import DelivererModel from "../models/deliverer.model";
import TransporterModel from "../models/transporter.model";
import ClientModel from "../models/client.model";
import SupervisorModel from "../models/supervisor.model";
import FreelancerModel from "../models/freelancer.model";
import PackageModel from "../models/package.model";
import ManifestModel from "../models/manifest.model";
import RouteModel from "../models/route.model";
import { IUser } from "../models/user.model";
import sendSMS from "../utils/sendSMS";
import PaymentModel from "../models/payment.model";

import { PresenceService } from "./presence.service";



export type DeliveryUserRole = "deliverer" | "transporter" | "client" | "freelancer" | "supervisor" | "manager" | "admin";

interface LocationUpdateData {
  userId: string;
  role: DeliveryUserRole;
  coordinates: [number, number];
  timestamp: Date;
}

interface ActiveDelivery {
  packageId: string;
  delivererId: string;   // userId (string)
  clientId?: string;     // userId (string) – only for home deliveries
}

interface ActiveTransit {
  packageId: string;
  transporterId: string; // userId (string)
  originBranchId: string;
  destinationBranchId: string;
}

/**
 * Hub-to-hub manifest transit session.
 * One session per manifest (not per package) — the transporter carries
 * sealed bags, not individual packages.
 */
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

/** Returns true when a route type is a hub route (manifests, not raw packages). */
function isHubRoute(routeType: string): boolean {
  return routeType === "hub_to_hub" || routeType === "hub_to_branch";
}

/** Returns the manifest count for a stop (hub routes) or package count (others). */
function stopLoadCount(stop: any, routeType: string): number {
  if (isHubRoute(routeType)) {
    return (stop.manifestIds?.length ?? 0);
  }
  return stop.packageIds?.length ?? 0;
}



export class SocketService {
  private io: Server;

  // userId (string) → socketId
  private delivererSockets: Map<string, string>   = new Map();
  private transporterSockets: Map<string, string> = new Map();
  private clientSockets: Map<string, string>      = new Map();
  private freelancerSockets: Map<string, string>  = new Map();
  private supervisorSockets: Map<string, string>  = new Map();
  private managerSockets: Map<string, string>     = new Map();
  private adminSockets: Map<string, string>       = new Map();

  // packageId → active delivery session
  private activeDeliveries: Map<string, ActiveDelivery>         = new Map();
  // packageId → active transit session (legacy branch-to-branch)
  private activeTransits: Map<string, ActiveTransit>            = new Map();
  // manifestId → active hub manifest transit session
  private activeManifestTransits: Map<string, ActiveManifestTransit> = new Map();
  // packageId -> { code, expiresAt } -- in-memory, short-lived (10 min)
  private deliveryOTPs: Map<string, { code: string; expiresAt: number }> = new Map();

  // userId → pending offline timer (grace period for mobile reconnects)
  private disconnectTimers: Map<string, NodeJS.Timeout> = new Map();


  private getPackageRoom(packageId: string): string {
    return `package_${packageId}`;
  }

  private getBranchRoom(branchId: string): string {
    return `branch_${branchId}`;
  }

  private getCompanyRoom(companyId: string): string {
    return `company_${companyId}`;
  }

  private getRouteRoom(routeId: string): string {
    return `route_${routeId}`;
  }

  private getManifestRoom(manifestId: string): string {
    return `manifest_${manifestId}`;
  }


  /**
   * Calculate distance between two coordinates in kilometers using Haversine formula
   */
  private calculateDistance(
    coord1: [number, number],
    coord2: [number, number]
  ): number {
    const [lng1, lat1] = coord1;
    const [lng2, lat2] = coord2;
    
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lng2 - lng1);
    
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }


  constructor(io: Server) {
    this.io = io;
    this.setupSocketHandlers();
  }


  private setupSocketHandlers(): void {
    this.io.on("connection", async (socket: AuthenticatedSocket) => {
      const user = socket.user as IUser & { _id: mongoose.Types.ObjectId };

      if (!user) {
        socket.disconnect();
        return;
      }

      const userId = user._id.toString();
      const role   = user.role as DeliveryUserRole;

      console.log(`[Socket] Connected: userId=${userId} role=${role} socketId=${socket.id}`);

      // Register socket by role
      this.registerSocket(userId, role, socket.id);

      // ── PRESENCE: cancel grace-period timer if user reconnected in time ──
      if (role === "deliverer" || role === "transporter") {
        const pending = this.disconnectTimers.get(userId);
        if (pending) {
          clearTimeout(pending);
          this.disconnectTimers.delete(userId);
          console.log(`[Socket] Reconnected within grace period: userId=${userId}`);
        }
        // Mark online in Redis (HHASH + SET)
        await PresenceService.setOnline(userId, role).catch((err) =>
          console.error("[Socket] PresenceService.setOnline failed:", err.message)
        );
      }
      // ─────────────────────────────────────────────────────────────────────

      // Join company / branch rooms (populated by middleware or from DB)
      await this.joinRoleRooms(socket, userId, role);

      // Confirm connection to caller
      socket.emit("connected", {
        message: "Socket connected successfully",
        userId,
        role,
        socketId: socket.id,
        timestamp: new Date(),
      });

      // Broadcast online status to relevant parties
      await this.broadcastOnlineStatus(userId, role, true);


      // ══════════════════════════════════════════════════════════════════════
      //  LOCATION UPDATE
      // ══════════════════════════════════════════════════════════════════════

      socket.on(
        "update_location",
        async (data: { coordinates: [number, number] }) => {
          try {
            if (!data?.coordinates || !Array.isArray(data.coordinates) || data.coordinates.length !== 2) {
              socket.emit("location_update_error", { message: "Invalid coordinates format. Expected [longitude, latitude]." });
              return;
            }

            const [lng, lat] = data.coordinates;
            if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
              socket.emit("location_update_error", { message: "Coordinates out of valid range." });
              return;
            }

            if (role === "deliverer") {
              await DelivererModel.findOneAndUpdate(
                { userId },
                {
                  currentLocation: { type: "Point", coordinates: data.coordinates },
                  lastLocationUpdate: new Date(),
                  lastActiveAt: new Date(),
                }
              );

              await this.broadcastDelivererLocation(userId, data.coordinates);

            } else if (role === "transporter") {
              await TransporterModel.findOneAndUpdate(
                { userId },
                {
                  lastActiveAt: new Date(),
                }
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
                }
              );
            }

            socket.emit("location_update_success", {
              coordinates: data.coordinates,
              timestamp: new Date(),
            });

          } catch (error: any) {
            console.error("[Socket] Error updating location:", error);
            socket.emit("location_update_error", {
              message: "Failed to update location.",
              error: error.message,
            });
          }
        }
      );


      // ══════════════════════════════════════════════════════════════════════
      //  AVAILABILITY STATUS  (deliverer / transporter only)
      // ══════════════════════════════════════════════════════════════════════

      const availabilityHandler = async (data: {
        status: "available" | "on_route" | "off_duty" | "on_break" | "maintenance";
      }) => {
        try {
          const allowedStatuses = ["available", "on_route", "off_duty", "on_break", "maintenance"];
          if (!data?.status || !allowedStatuses.includes(data.status)) {
            socket.emit("availability_change_error", { message: `Invalid status. Must be one of: ${allowedStatuses.join(", ")}` });
            return;
          }

          if (role === "deliverer") {
            await DelivererModel.findOneAndUpdate(
              { userId },
              { availabilityStatus: data.status, lastActiveAt: new Date() }
            );
            await this.notifyDelivererStatusToTrackers(userId, data.status);
          } else if (role === "transporter") {
            await TransporterModel.findOneAndUpdate(
              { userId },
              { availabilityStatus: data.status, lastActiveAt: new Date() }
            );
          }

          socket.emit("availability_change_success", {
            status: data.status,
            timestamp: new Date(),
          });

          console.log(`[Socket] ${role} ${userId} changed availability → ${data.status}`);
        } catch (error: any) {
          console.error(`[Socket] Error changing ${role} availability:`, error);
          socket.emit("availability_change_error", {
            message: "Failed to update availability status.",
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
        // Tap "Start Route". Route must be status=assigned and assigned to this transporter.
        socket.on("start_route", async (data: { routeId: string }) => {
          try {
            if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
              socket.emit("route_error", { code: "INVALID_ROUTE_ID", message: "Invalid routeId." });
              return;
            }

            const transporter = await TransporterModel.findOne({ userId }).lean();
            if (!transporter) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Transporter profile not found." });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedTransporterId: transporter._id,
              status: "assigned",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Route not found, already started, or not assigned to you." });
              return;
            }

            await route.startRoute();

            // Join the route room for subsequent stop events
            socket.join(this.getRouteRoom(data.routeId));

            // Mark transporter on_route
            await TransporterModel.findByIdAndUpdate(transporter._id, {
              availabilityStatus: "on_route",
              lastActiveAt: new Date(),
            });

            // For hub_to_hub: mark all manifests on this route as in_transit
            if (isHubRoute(route.type)) {
              const allManifestIds = route.stops.flatMap(
                (s: any) => s.manifestIds ?? []
              );
              if (allManifestIds.length > 0) {
                await ManifestModel.updateMany(
                  { _id: { $in: allManifestIds }, status: { $in: ["sealed", "loaded"] } },
                  {
                    $set: {
                      status: "in_transit",
                      departedAt: new Date(),
                      "transportLeg.departedAt": new Date(),
                    },
                  }
                );
              }
            }

            const firstStop  = route.stops[0];
            const routeType  = route.type;
            const hubRoute   = isHubRoute(routeType);

            // Notify supervisor branch room
            if (transporter.currentBranchId) {
              this.io.to(this.getBranchRoom(transporter.currentBranchId.toString())).emit("transporter_route_started", {
                routeId:       data.routeId,
                routeNumber:   route.routeNumber,
                routeType,
                transporterId: transporter._id,
                userId,
                totalStops:    route.stops.length,
                firstStop: firstStop ? {
                  stopId:        firstStop._id,
                  branchId:      firstStop.branchId,
                  address:       firstStop.address,
                  location:      firstStop.location.coordinates,
                  loadCount:     stopLoadCount(firstStop, routeType),
                  loadUnit:      hubRoute ? "manifests" : "packages",
                } : null,
                actualStart:  route.actualStart,
                scheduledEnd: route.scheduledEnd,
                timestamp: new Date(),
              });
            }

            // Confirm to transporter
            socket.emit("route_started", {
              routeId:          data.routeId,
              routeNumber:      route.routeNumber,
              routeType,
              status:           "active",
              currentStopIndex: 0,
              totalStops:       route.stops.length,
              currentStop: firstStop ? {
                stopId:      firstStop._id,
                branchId:    firstStop.branchId,
                address:     firstStop.address,
                location:    firstStop.location.coordinates,
                loadCount:   stopLoadCount(firstStop, routeType),
                loadUnit:    hubRoute ? "manifests" : "packages",
                manifestIds: hubRoute ? (firstStop.manifestIds ?? []) : undefined,
                packageIds:  !hubRoute ? firstStop.packageIds : undefined,
                order:       firstStop.order,
              } : null,
              scheduledEnd: route.scheduledEnd,
              timestamp: new Date(),
            });

            console.log(`[Socket] Transporter ${userId} started route ${data.routeId} (${routeType})`);
          } catch (err: any) {
            console.error("[Socket] start_route failed:", err);
            socket.emit("route_error", { code: "START_FAILED", message: err.message || "Failed to start route." });
          }
        });

        // ── arrived_at_stop ──────────────────────────────────────────────────
        // Transporter taps "I'm here" at a stop.
        // Conditions:
        //   1. Route status = active.
        //   2. stopIndex must equal route.currentStopIndex (must go in order).
        //   3. Transporter must be within the allowed distance (500m for hub, 50m for others).
        socket.on("arrived_at_stop", async (data: {
          routeId:     string;
          stopIndex:   number;
          coordinates: [number, number];
        }) => {
          try {
            if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
              socket.emit("route_error", { code: "INVALID_ROUTE_ID", message: "Invalid routeId." });
              return;
            }
            if (data.stopIndex === undefined || data.stopIndex < 0) {
              socket.emit("route_error", { code: "INVALID_STOP", message: "Invalid stopIndex." });
              return;
            }
            if (!data?.coordinates || data.coordinates.length !== 2) {
              socket.emit("route_error", { code: "NO_COORDINATES", message: "Current coordinates are required." });
              return;
            }

            const transporter = await TransporterModel.findOne({ userId }).lean();
            if (!transporter) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Transporter profile not found." });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedTransporterId: transporter._id,
              status: "active",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }

            // Must arrive at stops in order
            if (data.stopIndex !== route.currentStopIndex) {
              socket.emit("route_error", {
                code: "WRONG_STOP",
                message: `Expected stop ${route.currentStopIndex}, received ${data.stopIndex}.`,
                expectedStopIndex: route.currentStopIndex,
              });
              return;
            }

            const stop = route.stops[data.stopIndex];
            if (!stop) {
              socket.emit("route_error", { code: "STOP_NOT_FOUND", message: "Stop not found in route." });
              return;
            }

            const hubRoute      = isHubRoute(route.type);
            // Hub depots are large — allow 500m; regular branch stops stay at 50m
            const maxDistanceM  = hubRoute ? 500 : 50;
            const stopCoords    = stop.location.coordinates;
            const distanceMeters = this.calculateDistance(data.coordinates, stopCoords) * 1000;

            if (distanceMeters > maxDistanceM) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be within ${maxDistanceM}m of the stop to mark arrival. Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: maxDistanceM,
                stopLocation: stopCoords,
              });
              return;
            }

            // Mark arrived and record actualArrival
            stop.status        = "arrived";
            stop.actualArrival = new Date();
            await route.save();

            await TransporterModel.findByIdAndUpdate(transporter._id, { lastActiveAt: new Date() });

            const loadCount = stopLoadCount(stop, route.type);

            // Notify the branch room (supervisor sees transporter arrived)
            if (stop.branchId) {
              this.io.to(this.getBranchRoom(stop.branchId.toString())).emit(
                hubRoute ? "hub_transporter_arrived" : "transporter_arrived_at_branch",
                {
                  routeId:        data.routeId,
                  routeNumber:    route.routeNumber,
                  routeType:      route.type,
                  transporterId:  transporter._id,
                  stopIndex:      data.stopIndex,
                  stopId:         stop._id,
                  branchId:       stop.branchId,
                  distanceMeters: Math.round(distanceMeters),
                  loadCount,
                  loadUnit:       hubRoute ? "manifests" : "packages",
                  manifestIds:    hubRoute ? (stop.manifestIds ?? []) : undefined,
                  timestamp: new Date(),
                }
              );
            }

            // Broadcast to route room
            this.io.to(this.getRouteRoom(data.routeId)).emit("stop_arrived", {
              routeId:   data.routeId,
              stopIndex: data.stopIndex,
              stopId:    stop._id,
              branchId:  stop.branchId,
              timestamp: new Date(),
            });

            // Confirm to transporter
            socket.emit("arrived_at_stop_confirmed", {
              routeId:        data.routeId,
              stopIndex:      data.stopIndex,
              stopId:         stop._id,
              branchId:       stop.branchId,
              address:        stop.address,
              loadCount,
              loadUnit:       hubRoute ? "manifests" : "packages",
              manifestIds:    hubRoute ? (stop.manifestIds ?? []) : undefined,
              packageIds:     !hubRoute ? stop.packageIds : undefined,
              distanceMeters: Math.round(distanceMeters),
              timestamp: new Date(),
            });

            console.log(`[Socket] Transporter ${userId} arrived at stop ${data.stopIndex} (${Math.round(distanceMeters)}m, ${route.type})`);
          } catch (err: any) {
            console.error("[Socket] arrived_at_stop failed:", err);
            socket.emit("route_error", { code: "ARRIVE_FAILED", message: err.message || "Failed to mark arrival." });
          }
        });

        // ── complete_stop ────────────────────────────────────────────────────
        // Transporter confirms packages/manifests are unloaded at this stop.
        // Hub_to_hub: validate manifestIds against stop.manifestIds.
        // Other routes: validate packageIds against stop.packageIds (unchanged).
        // If this is the last stop → route.completeRoute() fires automatically
        //   and the transporter receives a "route_completed" push notification.
        socket.on("complete_stop", async (data: {
          routeId:                 string;
          stopIndex:               number;
          coordinates:             [number, number];
          // Non-hub routes
          completedPackageIds?:    string[];
          failedPackageIds?:       string[];
          // Hub routes
          completedManifestIds?:   string[];
          discrepancyManifestIds?: string[];
          notes?:                  string;
        }) => {
          try {
            if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
              socket.emit("route_error", { code: "INVALID_ROUTE_ID", message: "Invalid routeId." });
              return;
            }
            if (data.stopIndex === undefined || data.stopIndex < 0) {
              socket.emit("route_error", { code: "INVALID_STOP", message: "Invalid stopIndex." });
              return;
            }
            if (!data?.coordinates || data.coordinates.length !== 2) {
              socket.emit("route_error", { code: "NO_COORDINATES", message: "Current coordinates are required." });
              return;
            }

            const transporter = await TransporterModel.findOne({ userId }).lean();
            if (!transporter) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Transporter profile not found." });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedTransporterId: transporter._id,
              status: "active",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }

            // Enforce sequential stop order
            if (data.stopIndex !== route.currentStopIndex) {
              socket.emit("route_error", {
                code: "WRONG_STOP",
                message: `Expected stop ${route.currentStopIndex}, received ${data.stopIndex}.`,
                expectedStopIndex: route.currentStopIndex,
              });
              return;
            }

            const stop = route.stops[data.stopIndex];
            if (!stop) {
              socket.emit("route_error", { code: "STOP_NOT_FOUND", message: "Stop not found in route." });
              return;
            }

            if (!["arrived", "in_progress", "pending"].includes(stop.status)) {
              socket.emit("route_error", {
                code: "INVALID_STOP_STATUS",
                message: `Stop status is '${stop.status}' — cannot complete.`,
              });
              return;
            }

            const hubRoute      = isHubRoute(route.type);
            const maxDistanceM  = hubRoute ? 500 : 50;
            const stopCoords    = stop.location.coordinates;
            const distanceMeters = this.calculateDistance(data.coordinates, stopCoords) * 1000;

            if (distanceMeters > maxDistanceM) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be within ${maxDistanceM}m of the stop to complete it. Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: maxDistanceM,
                stopLocation: stopCoords,
              });
              return;
            }

            const isLastStop   = data.stopIndex === route.stops.length - 1;
            const routeRoom    = this.getRouteRoom(data.routeId);

            if (hubRoute) {
              // ── HUB ROUTE: work with manifests ───────────────────────────

              const stopManifestSet = new Set(
                (stop.manifestIds ?? []).map((id: mongoose.Types.ObjectId) => id.toString())
              );

              // Validate completed manifests
              const completedManifestOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of (data.completedManifestIds ?? [])) {
                if (!mongoose.Types.ObjectId.isValid(idStr)) {
                  socket.emit("route_error", { code: "INVALID_MANIFEST_ID", message: `Invalid manifest ID: ${idStr}` });
                  return;
                }
                if (!stopManifestSet.has(idStr)) {
                  socket.emit("route_error", { code: "MANIFEST_NOT_IN_STOP", message: `Manifest ${idStr} does not belong to stop ${data.stopIndex}.` });
                  return;
                }
                completedManifestOids.push(new mongoose.Types.ObjectId(idStr));
              }

              const discrepancyManifestOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of (data.discrepancyManifestIds ?? [])) {
                if (!mongoose.Types.ObjectId.isValid(idStr)) {
                  socket.emit("route_error", { code: "INVALID_MANIFEST_ID", message: `Invalid manifest ID: ${idStr}` });
                  return;
                }
                if (!stopManifestSet.has(idStr)) {
                  socket.emit("route_error", { code: "MANIFEST_NOT_IN_STOP", message: `Manifest ${idStr} does not belong to stop ${data.stopIndex}.` });
                  return;
                }
                discrepancyManifestOids.push(new mongoose.Types.ObjectId(idStr));
              }

              // Default: treat all manifests as completed if no breakdown given
              const finalCompletedManifests =
                completedManifestOids.length > 0
                  ? completedManifestOids
                  : (stop.manifestIds as mongoose.Types.ObjectId[]) ?? [];

              // Persist stop-level manifest tracking on route document
              stop.completedManifests   = finalCompletedManifests;
              stop.discrepancyManifests = discrepancyManifestOids;
              await route.completeStop(data.stopIndex, [], [], data.notes);

              // Mark manifests as arrived and cascade to packages
              if (finalCompletedManifests.length > 0) {
                await ManifestModel.updateMany(
                  { _id: { $in: finalCompletedManifests }, status: "in_transit" },
                  {
                    $set: {
                      status:                   "arrived",
                      arrivedAt:                new Date(),
                      "transportLeg.arrivedAt": new Date(),
                    },
                  }
                );

                // Cascade package statuses via the manifest model's method
                for (const manifestId of finalCompletedManifests) {
                  const manifest = await ManifestModel.findById(manifestId);
                  if (manifest) {
                    await manifest.markArrived(
                      new mongoose.Types.ObjectId(userId)
                    );
                  }
                }
              }

              if (discrepancyManifestOids.length > 0) {
                await ManifestModel.updateMany(
                  { _id: { $in: discrepancyManifestOids } },
                  { $set: { status: "discrepancy" } }
                );
              }

              // Update transporter's currentBranchId on last stop (hub_to_hub return trip)
              if (isLastStop && route.type === "hub_to_hub" && stop.branchId) {
                await TransporterModel.findByIdAndUpdate(transporter._id, {
                  availabilityStatus: "available",
                  currentRouteId:     null,
                  currentBranchId:    stop.branchId,
                  lastActiveAt: new Date(),
                  $inc: { totalTrips: 1, completedTrips: 1 },
                });
              } else if (isLastStop) {
                await TransporterModel.findByIdAndUpdate(transporter._id, {
                  availabilityStatus: "available",
                  currentRouteId:     null,
                  lastActiveAt: new Date(),
                  $inc: { totalTrips: 1, completedTrips: 1 },
                });
              }

              // Notify destination hub room
              if (stop.branchId) {
                this.io.to(this.getBranchRoom(stop.branchId.toString())).emit("hub_manifests_delivered", {
                  routeId:              data.routeId,
                  routeNumber:          route.routeNumber,
                  transporterId:        transporter._id,
                  stopIndex:            data.stopIndex,
                  completedManifests:   finalCompletedManifests.length,
                  discrepancyManifests: discrepancyManifestOids.length,
                  routeCompleted:       isLastStop,
                  timestamp: new Date(),
                });
              }

              if (isLastStop) {
                await route.completeRoute(data.notes);

                socket.emit("route_completed", {
                  routeId:           data.routeId,
                  routeNumber:       route.routeNumber,
                  routeType:         route.type,
                  totalStops:        route.stops.length,
                  completedStops:    route.completedStops,
                  actualStart:       route.actualStart,
                  actualEnd:         route.actualEnd,
                  onTimePerformance: route.onTimePerformance,
                  message:           "Hub route completed. You are now available at the destination hub.",
                  timestamp: new Date(),
                });

                // Notify company room
                this.io.to(this.getCompanyRoom(transporter.companyId.toString())).emit("transporter_route_completed", {
                  routeId:       data.routeId,
                  routeNumber:   route.routeNumber,
                  routeType:     route.type,
                  transporterId: transporter._id,
                  userId,
                  onTimePerformance: route.onTimePerformance,
                  timestamp: new Date(),
                });

                this.io.to(routeRoom).emit("route_completed", {
                  routeId:    data.routeId,
                  routeNumber: route.routeNumber,
                  timestamp:  new Date(),
                });

                console.log(`[Socket] Transporter ${userId} COMPLETED hub route ${data.routeId}`);
              } else {
                const nextStop = route.stops[data.stopIndex + 1];
                socket.emit("stop_completed", {
                  routeId:              data.routeId,
                  completedStopIndex:   data.stopIndex,
                  completedStopId:      stop._id,
                  branchId:             stop.branchId,
                  completedManifests:   finalCompletedManifests.length,
                  discrepancyManifests: discrepancyManifestOids.length,
                  distanceMeters:       Math.round(distanceMeters),
                  nextStop: nextStop ? {
                    stopIndex:      data.stopIndex + 1,
                    stopId:         nextStop._id,
                    branchId:       nextStop.branchId,
                    address:        nextStop.address,
                    location:       nextStop.location.coordinates,
                    manifestCount:  nextStop.manifestIds?.length ?? 0,
                    order:          nextStop.order,
                  } : null,
                  remainingStops: route.stops.length - (data.stopIndex + 1),
                  timestamp: new Date(),
                });

                if (stop.branchId) {
                  this.io.to(this.getBranchRoom(stop.branchId.toString())).emit("transporter_left_hub", {
                    routeId:          data.routeId,
                    transporterId:    transporter._id,
                    completedManifests: finalCompletedManifests.length,
                    timestamp: new Date(),
                  });
                }
                if (nextStop?.branchId) {
                  this.io.to(this.getBranchRoom(nextStop.branchId.toString())).emit("hub_transporter_en_route", {
                    routeId:          data.routeId,
                    routeNumber:      route.routeNumber,
                    transporterId:    transporter._id,
                    manifestCount:    nextStop.manifestIds?.length ?? 0,
                    estimatedArrival: nextStop.expectedArrival,
                    timestamp: new Date(),
                  });
                }

                this.io.to(routeRoom).emit("stop_completed", {
                  routeId:       data.routeId,
                  stopIndex:     data.stopIndex,
                  stopId:        stop._id,
                  nextStopIndex: data.stopIndex + 1,
                  timestamp: new Date(),
                });

                console.log(`[Socket] Transporter ${userId} completed hub stop ${data.stopIndex}/${route.stops.length - 1}`);
              }

            } else {
              // ── NON-HUB ROUTE: original package-based logic ──────────────

              const stopPackageSet = new Set(
                (stop.packageIds as mongoose.Types.ObjectId[]).map((id) => id.toString())
              );

              const completedOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of (data.completedPackageIds ?? [])) {
                if (!mongoose.Types.ObjectId.isValid(idStr)) {
                  socket.emit("route_error", { code: "INVALID_PACKAGE_ID", message: `Invalid package ID: ${idStr}` });
                  return;
                }
                if (!stopPackageSet.has(idStr)) {
                  socket.emit("route_error", { code: "PACKAGE_NOT_IN_STOP", message: `Package ${idStr} does not belong to stop ${data.stopIndex}.` });
                  return;
                }
                completedOids.push(new mongoose.Types.ObjectId(idStr));
              }

              const failedOids: mongoose.Types.ObjectId[] = [];
              for (const idStr of (data.failedPackageIds ?? [])) {
                if (!mongoose.Types.ObjectId.isValid(idStr)) {
                  socket.emit("route_error", { code: "INVALID_PACKAGE_ID", message: `Invalid package ID: ${idStr}` });
                  return;
                }
                if (!stopPackageSet.has(idStr)) {
                  socket.emit("route_error", { code: "PACKAGE_NOT_IN_STOP", message: `Package ${idStr} does not belong to stop ${data.stopIndex}.` });
                  return;
                }
                failedOids.push(new mongoose.Types.ObjectId(idStr));
              }

              const finalCompleted = completedOids.length > 0
                ? completedOids
                : (stop.packageIds as mongoose.Types.ObjectId[]);

              await route.completeStop(data.stopIndex, finalCompleted, failedOids, data.notes);

              if (isLastStop) {
                await route.completeRoute(data.notes);

                await TransporterModel.findByIdAndUpdate(transporter._id, {
                  availabilityStatus: "available",
                  currentRouteId:     null,
                  lastActiveAt: new Date(),
                });

                socket.emit("route_completed", {
                  routeId:           data.routeId,
                  routeNumber:       route.routeNumber,
                  totalStops:        route.stops.length,
                  completedStops:    route.completedStops,
                  failedStops:       route.failedStops,
                  skippedStops:      route.skippedStops,
                  actualStart:       route.actualStart,
                  actualEnd:         route.actualEnd,
                  actualTime:        route.actualTime,
                  onTimePerformance: route.onTimePerformance,
                  message: "Route completed successfully! Great work today.",
                  timestamp: new Date(),
                });

                const branchIds = new Set<string>();
                route.stops.forEach((s: any) => { if (s.branchId) branchIds.add(s.branchId.toString()); });
                branchIds.forEach((bId) => {
                  this.io.to(this.getBranchRoom(bId)).emit("transporter_route_completed", {
                    routeId:       data.routeId,
                    routeNumber:   route.routeNumber,
                    transporterId: transporter._id,
                    userId,
                    onTimePerformance: route.onTimePerformance,
                    timestamp: new Date(),
                  });
                });

                this.io.to(this.getCompanyRoom(transporter.companyId.toString())).emit("transporter_route_completed", {
                  routeId:           data.routeId,
                  routeNumber:       route.routeNumber,
                  transporterId:     transporter._id,
                  userId,
                  onTimePerformance: route.onTimePerformance,
                  timestamp: new Date(),
                });

                this.io.to(routeRoom).emit("route_completed", {
                  routeId:    data.routeId,
                  routeNumber: route.routeNumber,
                  timestamp:  new Date(),
                });

                console.log(`[Socket] Transporter ${userId} COMPLETED route ${data.routeId}`);
              } else {
                const nextStop = route.stops[data.stopIndex + 1];
                socket.emit("stop_completed", {
                  routeId:            data.routeId,
                  completedStopIndex: data.stopIndex,
                  completedStopId:    stop._id,
                  branchId:           stop.branchId,
                  completedPackages:  finalCompleted.length,
                  failedPackages:     failedOids.length,
                  distanceMeters:     Math.round(distanceMeters),
                  nextStop: nextStop ? {
                    stopIndex:   data.stopIndex + 1,
                    stopId:      nextStop._id,
                    branchId:    nextStop.branchId,
                    address:     nextStop.address,
                    location:    nextStop.location.coordinates,
                    packageCount: nextStop.packageIds.length,
                    order:       nextStop.order,
                  } : null,
                  remainingStops: route.stops.length - (data.stopIndex + 1),
                  timestamp: new Date(),
                });

                if (stop.branchId) {
                  this.io.to(this.getBranchRoom(stop.branchId.toString())).emit("transporter_left_branch", {
                    routeId:          data.routeId,
                    routeNumber:      route.routeNumber,
                    transporterId:    transporter._id,
                    completedPackages: finalCompleted.length,
                    failedPackages:    failedOids.length,
                    timestamp: new Date(),
                  });
                }

                if (nextStop?.branchId) {
                  this.io.to(this.getBranchRoom(nextStop.branchId.toString())).emit("transporter_en_route_to_branch", {
                    routeId:          data.routeId,
                    routeNumber:      route.routeNumber,
                    transporterId:    transporter._id,
                    packageCount:     nextStop.packageIds.length,
                    estimatedArrival: nextStop.expectedArrival,
                    timestamp: new Date(),
                  });
                }

                this.io.to(routeRoom).emit("stop_completed", {
                  routeId:       data.routeId,
                  stopIndex:     data.stopIndex,
                  stopId:        stop._id,
                  nextStopIndex: data.stopIndex + 1,
                  timestamp: new Date(),
                });

                console.log(`[Socket] Transporter ${userId} completed stop ${data.stopIndex}/${route.stops.length - 1}`);
              }
            }
          } catch (err: any) {
            console.error("[Socket] complete_stop failed:", err);
            socket.emit("route_error", { code: "COMPLETE_STOP_FAILED", message: err.message || "Failed to complete stop." });
          }
        });

        // ── fail_stop ────────────────────────────────────────────────────────
        // Transporter could not deliver packages/manifests at a stop.
        // Advances currentStopIndex so the route continues.
        // If it's the last stop, the route is still completed.
        socket.on("fail_stop", async (data: {
          routeId:             string;
          stopIndex:           number;
          reason:              string;
          skippedPackageIds?:  string[];
          skippedManifestIds?: string[];
        }) => {
          try {
            if (!data?.routeId || !data?.reason) {
              socket.emit("route_error", { code: "MISSING_DATA", message: "routeId and reason are required." });
              return;
            }

            const transporter = await TransporterModel.findOne({ userId }).lean();
            if (!transporter) return;

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedTransporterId: transporter._id,
              status: "active",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }

            const skippedOids = (data.skippedPackageIds ?? [])
              .filter((id) => mongoose.Types.ObjectId.isValid(id))
              .map((id) => new mongoose.Types.ObjectId(id));

            await route.failStop(data.stopIndex, data.reason, skippedOids);

            const stop       = route.stops[data.stopIndex];
            const isLastStop = data.stopIndex === route.stops.length - 1;
            const hubRoute   = isHubRoute(route.type);

            socket.emit("stop_failed", {
              routeId:        data.routeId,
              stopIndex:      data.stopIndex,
              stopId:         stop?._id,
              branchId:       stop?.branchId,
              reason:         data.reason,
              remainingStops: isLastStop ? 0 : route.stops.length - (data.stopIndex + 1),
              timestamp: new Date(),
            });

            // Notify the branch that the delivery failed
            if (stop?.branchId) {
              this.io.to(this.getBranchRoom(stop.branchId.toString())).emit(
                hubRoute ? "hub_stop_failed" : "transporter_stop_failed",
                {
                  routeId:       data.routeId,
                  transporterId: transporter._id,
                  stopId:        stop._id,
                  branchId:      stop.branchId,
                  reason:        data.reason,
                  timestamp: new Date(),
                }
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
                routeId:    data.routeId,
                routeNumber: route.routeNumber,
                status:     "completed",
                message:    "Route completed. Last stop failed — your supervisor has been notified.",
                timestamp: new Date(),
              });
            }
          } catch (err: any) {
            console.error("[Socket] fail_stop failed:", err);
            socket.emit("route_error", { code: "FAIL_STOP_FAILED", message: err.message || "Failed to record stop failure." });
          }
        });

        // ── pause_route ──────────────────────────────────────────────────────
        socket.on("pause_route", async (data: { routeId: string; reason?: string }) => {
          try {
            const transporter = await TransporterModel.findOne({ userId }).lean();
            if (!transporter) return;

            const route = await RouteModel.findOne({
              _id: data?.routeId,
              assignedTransporterId: transporter._id,
              status: "active",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }

            await route.pauseRoute(data?.reason);

            socket.emit("route_paused", {
              routeId:  data.routeId,
              reason:   data?.reason,
              pausedAt: new Date(),
            });

            if (transporter.currentBranchId) {
              this.io.to(this.getBranchRoom(transporter.currentBranchId.toString())).emit(
                "transporter_route_paused",
                { routeId: data.routeId, transporterId: transporter._id, reason: data?.reason, timestamp: new Date() }
              );
            }
          } catch (err: any) {
            socket.emit("route_error", { code: "PAUSE_FAILED", message: err.message });
          }
        });

        // ── resume_route ─────────────────────────────────────────────────────
        socket.on("resume_route", async (data: { routeId: string }) => {
          try {
            const transporter = await TransporterModel.findOne({ userId }).lean();
            if (!transporter) return;

            const route = await RouteModel.findOne({
              _id: data?.routeId,
              assignedTransporterId: transporter._id,
              status: "paused",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Paused route not found." });
              return;
            }

            await route.resumeRoute();
            const currentStop = route.stops[route.currentStopIndex];
            const hubRoute    = isHubRoute(route.type);

            socket.emit("route_resumed", {
              routeId:          data.routeId,
              currentStopIndex: route.currentStopIndex,
              currentStop: currentStop ? {
                stopId:      currentStop._id,
                branchId:    currentStop.branchId,
                address:     currentStop.address,
                location:    currentStop.location.coordinates,
                loadCount:   stopLoadCount(currentStop, route.type),
                loadUnit:    hubRoute ? "manifests" : "packages",
              } : null,
              resumedAt: new Date(),
            });

            if (transporter.currentBranchId) {
              this.io.to(this.getBranchRoom(transporter.currentBranchId.toString())).emit(
                "transporter_route_resumed",
                { routeId: data.routeId, transporterId: transporter._id, timestamp: new Date() }
              );
            }
          } catch (err: any) {
            socket.emit("route_error", { code: "RESUME_FAILED", message: err.message });
          }
        });

        // ── join_route_room ──────────────────────────────────────────────────
        // Transporter re-opens app mid-route and rejoins the room.
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
            socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "No active/paused route found." });
            return;
          }

          socket.join(this.getRouteRoom(data.routeId));
          const currentStop = route.stops[route.currentStopIndex];
          const hubRoute    = isHubRoute(route.type);

          socket.emit("route_rejoined", {
            routeId:          data.routeId,
            routeNumber:      route.routeNumber,
            routeType:        route.type,
            status:           route.status,
            currentStopIndex: route.currentStopIndex,
            totalStops:       route.stops.length,
            completedStops:   route.completedStops,
            currentStop: currentStop ? {
              stopId:       currentStop._id,
              branchId:     currentStop.branchId,
              address:      currentStop.address,
              location:     currentStop.location.coordinates,
              status:       currentStop.status,
              loadCount:    stopLoadCount(currentStop, route.type),
              loadUnit:     hubRoute ? "manifests" : "packages",
              manifestIds:  hubRoute ? (currentStop.manifestIds ?? []) : undefined,
              packageIds:   !hubRoute ? currentStop.packageIds : undefined,
            } : null,
            timestamp: new Date(),
          });
        });

      } // end if (role === "transporter")

      // ══════════════════════════════════════════════════════════════════════
      //  DELIVERER ROUTE EVENTS
      //
      //  Flow per stop (each stop = one home delivery to one client):
      //
      //  1.  start_delivery_route    — deliverer starts their daily route
      //  2.  arrived_at_delivery     — deliverer taps "I'm here" (50m check)
      //  3.  complete_delivery       — deliverer enters the 6-digit OTP + 50m check
      //                                → package marked delivered, next stop shown
      //  4.  fail_delivery_attempt   — client not responding; deliverer records reason
      //                                → package rescheduled (up to maxAttempts=3)
      //                                → if max reached → marked returned
      //  5.  return_package_to_branch— deliverer confirms return of failed packages
      //  6.  join_delivery_route_room— re-join on app re-open mid-route
      // ══════════════════════════════════════════════════════════════════════

      if (role === "deliverer") {

        // ── start_delivery_route ─────────────────────────────────────────────
        // Deliverer taps "Start Route" in their app.
        // Conditions: route must be status=assigned, assigned to this deliverer.
        // On success:
        //   - Route set to active
        //   - Deliverer set to on_route
        //   - 6-digit OTP generated for the FIRST stop's package and sent via SMS
        //   - Supervisor branch room notified
        socket.on("start_delivery_route", async (data: { routeId: string }) => {
          try {
            if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
              socket.emit("route_error", { code: "INVALID_ROUTE_ID", message: "Invalid routeId." });
              return;
            }

            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Deliverer profile not found." });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedDelivererId: deliverer._id,
              status: "assigned",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Route not found, already started, or not assigned to you." });
              return;
            }

            await route.startRoute();

            // Join the route room
            socket.join(this.getRouteRoom(data.routeId));

            // Mark deliverer on_route
            await DelivererModel.findByIdAndUpdate(deliverer._id, {
              availabilityStatus: "on_route",
              currentRouteId: route._id,
              lastActiveAt: new Date(),
            });

            // Generate and send OTP for the first stop
            if (route.stops.length > 0) {
              await this.generateAndSendDeliveryOTP(route, 0, data.routeId);
            }

            // Notify branch room
            this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit("deliverer_route_started", {
              routeId:      data.routeId,
              routeNumber:  route.routeNumber,
              delivererId:  deliverer._id,
              userId,
              totalStops:   route.stops.length,
              actualStart:  route.actualStart,
              scheduledEnd: route.scheduledEnd,
              timestamp: new Date(),
            });

            const firstStop = route.stops[0];
            socket.emit("delivery_route_started", {
              routeId:          data.routeId,
              routeNumber:      route.routeNumber,
              status:           "active",
              currentStopIndex: 0,
              totalStops:       route.stops.length,
              currentStop: firstStop ? {
                stopId:         firstStop._id,
                clientId:       firstStop.clientId,
                packageId:      firstStop.packageIds[0],
                address:        firstStop.address,
                location:       firstStop.location.coordinates,
                recipientName:  (firstStop as any).recipientName,
                recipientPhone: (firstStop as any).recipientPhone,
                otpSent: true,
              } : null,
              scheduledEnd: route.scheduledEnd,
              timestamp: new Date(),
            });

            console.log(`[Socket] Deliverer ${userId} started delivery route ${data.routeId}`);
          } catch (err: any) {
            console.error("[Socket] start_delivery_route failed:", err);
            socket.emit("route_error", { code: "START_FAILED", message: err.message || "Failed to start route." });
          }
        });

        // ── arrived_at_delivery ──────────────────────────────────────────────
        // Deliverer signals they have arrived at a client's location.
        // Conditions: 50m proximity check against stop location.
        // On success: stop status → arrived, actualArrival recorded.
        socket.on("arrived_at_delivery", async (data: {
          routeId:     string;
          stopIndex:   number;
          coordinates: [number, number];
        }) => {
          try {
            if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
              socket.emit("route_error", { code: "INVALID_ROUTE_ID", message: "Invalid routeId." });
              return;
            }
            if (!data?.coordinates || data.coordinates.length !== 2) {
              socket.emit("route_error", { code: "NO_COORDINATES", message: "Current coordinates are required." });
              return;
            }

            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Deliverer profile not found." });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedDelivererId: deliverer._id,
              status: "active",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }

            if (data.stopIndex !== route.currentStopIndex) {
              socket.emit("route_error", {
                code: "WRONG_STOP",
                message: `Expected stop ${route.currentStopIndex}, received ${data.stopIndex}.`,
                expectedStopIndex: route.currentStopIndex,
              });
              return;
            }

            const stop = route.stops[data.stopIndex];
            if (!stop) {
              socket.emit("route_error", { code: "STOP_NOT_FOUND", message: "Stop not found in route." });
              return;
            }

            // Proximity check: 50m
            const stopCoords = stop.location.coordinates;
            const distanceMeters = this.calculateDistance(data.coordinates, stopCoords) * 1000;
            if (distanceMeters > 50) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be within 50m of the delivery address. Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: 50,
                stopLocation: stopCoords,
              });
              return;
            }

            // Mark arrived
            stop.status        = "arrived";
            stop.actualArrival = new Date();
            await route.save();

            await DelivererModel.findByIdAndUpdate(deliverer._id, { lastActiveAt: new Date() });

            // Notify branch room
            this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit("deliverer_arrived_at_client", {
              routeId:        data.routeId,
              delivererId:    deliverer._id,
              stopIndex:      data.stopIndex,
              stopId:         stop._id,
              clientId:       stop.clientId,
              distanceMeters: Math.round(distanceMeters),
              timestamp: new Date(),
            });

            // Notify tracking room for the package
            if (stop.packageIds[0]) {
              this.io.to(this.getPackageRoom(stop.packageIds[0].toString())).emit("deliverer_arrived", {
                packageId:      stop.packageIds[0],
                delivererId:    deliverer._id,
                distanceMeters: Math.round(distanceMeters),
                message: "Your deliverer has arrived!",
                timestamp: new Date(),
              });
            }

            socket.emit("arrived_at_delivery_confirmed", {
              routeId:        data.routeId,
              stopIndex:      data.stopIndex,
              stopId:         stop._id,
              packageId:      stop.packageIds[0],
              address:        stop.address,
              distanceMeters: Math.round(distanceMeters),
              message: "Arrival confirmed. Ask the client for the OTP code.",
              timestamp: new Date(),
            });

            console.log(`[Socket] Deliverer ${userId} arrived at stop ${data.stopIndex} (${Math.round(distanceMeters)}m)`);
          } catch (err: any) {
            console.error("[Socket] arrived_at_delivery failed:", err);
            socket.emit("route_error", { code: "ARRIVE_FAILED", message: err.message || "Failed to mark arrival." });
          }
        });

        // ── complete_delivery ─────────────────────────────────────────────────
        // Deliverer enters the OTP the client received by SMS.
        // Conditions:
        //   1. Route active, stop in order.
        //   2. Deliverer within 50m of stop location.
        //   3. OTP matches the stored code and is not expired (10 min window).
        // On success:
        //   - Package → delivered, trackingHistory updated.
        //   - Stop completed via route.completeStop().
        //   - OTP for next stop generated and sent.
        //   - If last stop → route completed, deliverer freed.
        socket.on("complete_delivery", async (data: {
          routeId:     string;
          stopIndex:   number;
          coordinates: [number, number];
          otp:         string;
          notes?:      string;
        }) => {
          try {
            if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
              socket.emit("route_error", { code: "INVALID_ROUTE_ID", message: "Invalid routeId." });
              return;
            }
            if (!data?.coordinates || data.coordinates.length !== 2) {
              socket.emit("route_error", { code: "NO_COORDINATES", message: "Current coordinates are required." });
              return;
            }
            if (!data?.otp || typeof data.otp !== "string") {
              socket.emit("route_error", { code: "OTP_REQUIRED", message: "OTP code is required." });
              return;
            }

            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Deliverer profile not found." });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedDelivererId: deliverer._id,
              status: "active",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }

            if (data.stopIndex !== route.currentStopIndex) {
              socket.emit("route_error", {
                code: "WRONG_STOP",
                message: `Expected stop ${route.currentStopIndex}, received ${data.stopIndex}.`,
                expectedStopIndex: route.currentStopIndex,
              });
              return;
            }

            const stop = route.stops[data.stopIndex];
            if (!stop || !stop.packageIds[0]) {
              socket.emit("route_error", { code: "STOP_NOT_FOUND", message: "Stop or package not found." });
              return;
            }

            // Proximity check: 50m
            const stopCoords = stop.location.coordinates;
            const distanceMeters = this.calculateDistance(data.coordinates, stopCoords) * 1000;
            if (distanceMeters > 50) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be within 50m to complete the delivery. Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: 50,
              });
              return;
            }

            // OTP validation
            const packageId = stop.packageIds[0].toString();
            const otpKey    = `delivery_otp_${packageId}`;
            const stored    = this.deliveryOTPs.get(otpKey);

            if (!stored) {
              socket.emit("route_error", { code: "OTP_NOT_FOUND", message: "No OTP found. Request a new code." });
              return;
            }
            if (Date.now() > stored.expiresAt) {
              this.deliveryOTPs.delete(otpKey);
              socket.emit("route_error", { code: "OTP_EXPIRED", message: "OTP has expired. A new code has been sent to the client." });
              // Regenerate and resend
              await this.generateAndSendDeliveryOTP(route, data.stopIndex, data.routeId);
              return;
            }
            if (stored.code !== data.otp.trim()) {
              socket.emit("route_error", { code: "OTP_MISMATCH", message: "Incorrect OTP. Please try again." });
              return;
            }

            // OTP correct — mark package delivered
            const pkg = await PackageModel.findById(packageId);
            if (!pkg) {
              socket.emit("route_error", { code: "PACKAGE_NOT_FOUND", message: "Package not found." });
              return;
            }

            await pkg.markAsDelivered(deliverer.userId, data.notes);

            // Update payment status to collected
            await PaymentModel.findOneAndUpdate(
              { packageId: packageId },
              {
                $set: {
                  status: 'collected',
                  delivererId: deliverer.userId
                }
              }
            );

            // Complete the stop
            await route.completeStop(
              data.stopIndex,
              [new mongoose.Types.ObjectId(packageId)],
              [],
              data.notes
            );

            // Clean up OTP
            this.deliveryOTPs.delete(otpKey);

            // ── Update deliverer earnings & stats ──────────────────────────
            const delivererDoc = await DelivererModel.findById(deliverer._id);
            if (delivererDoc) {
              const isCOD = pkg.paymentMethod === "cod";
              await delivererDoc.recordDeliveryPayment(pkg.totalPrice, isCOD);

              // Also update delivery counters
              delivererDoc.totalDeliveries += 1;
              delivererDoc.successfulDeliveries += 1;
              delivererDoc.lastActiveAt = new Date();
              await delivererDoc.save();
            }

            const isLastStop   = data.stopIndex === route.stops.length - 1;
            const routeRoom    = this.getRouteRoom(data.routeId);

            // Notify client/sender tracking room
            this.io.to(this.getPackageRoom(packageId)).emit("package_delivered", {
              packageId,
              deliveredAt: new Date(),
              message: "Your package has been delivered!",
              timestamp: new Date(),
            });

            if (isLastStop) {
              // ── All stops done ─────────────────────────────────────────
              await route.completeRoute(data.notes);

              await DelivererModel.findByIdAndUpdate(deliverer._id, {
                availabilityStatus: "available",
                currentRouteId:     null,
                lastActiveAt: new Date(),
              });

              socket.emit("delivery_route_completed", {
                routeId:        data.routeId,
                routeNumber:    route.routeNumber,
                totalStops:     route.stops.length,
                completedStops: route.completedStops,
                failedStops:    route.failedStops,
                actualStart:    route.actualStart,
                actualEnd:      route.actualEnd,
                actualTime:     route.actualTime,
                onTimePerformance: route.onTimePerformance,
                message: "Route completed successfully! Great work today.",
                timestamp: new Date(),
              });

              this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit("deliverer_route_completed", {
                routeId:      data.routeId,
                routeNumber:  route.routeNumber,
                delivererId:  deliverer._id,
                userId,
                onTimePerformance: route.onTimePerformance,
                timestamp: new Date(),
              });

              this.io.to(routeRoom).emit("delivery_route_completed", {
                routeId:    data.routeId,
                routeNumber: route.routeNumber,
                timestamp:  new Date(),
              });

              console.log(`[Socket] Deliverer ${userId} COMPLETED delivery route ${data.routeId}`);
            } else {
              // ── More stops remain ──────────────────────────────────────
              const nextStop = route.stops[data.stopIndex + 1];

              // Generate OTP for next stop immediately
              if (nextStop) {
                await this.generateAndSendDeliveryOTP(route, data.stopIndex + 1, data.routeId);
              }

              socket.emit("delivery_stop_completed", {
                routeId:            data.routeId,
                completedStopIndex: data.stopIndex,
                packageId,
                distanceMeters:     Math.round(distanceMeters),
                nextStop: nextStop ? {
                  stopIndex:      data.stopIndex + 1,
                  stopId:         nextStop._id,
                  clientId:       nextStop.clientId,
                  packageId:      nextStop.packageIds[0],
                  address:        nextStop.address,
                  location:       nextStop.location.coordinates,
                  otpSent: true,
                } : null,
                remainingStops: route.stops.length - (data.stopIndex + 1),
                timestamp: new Date(),
              });

              this.io.to(routeRoom).emit("delivery_stop_completed", {
                routeId:   data.routeId,
                stopIndex: data.stopIndex,
                packageId,
                timestamp: new Date(),
              });

              console.log(`[Socket] Deliverer ${userId} completed delivery stop ${data.stopIndex}/${route.stops.length - 1}`);
            }
          } catch (err: any) {
            console.error("[Socket] complete_delivery failed:", err);
            socket.emit("route_error", { code: "COMPLETE_FAILED", message: err.message || "Failed to complete delivery." });
          }
        });

        // ── fail_delivery_attempt ─────────────────────────────────────────────
        // Client is not available / not responding.
        // Conditions: deliverer must be within 50m (proves they were actually there).
        // Behaviour:
        //   - package.updateStatus('failed_delivery') which increments attemptCount
        //     and sets nextAttemptDate (+1 day).
        //   - If attemptCount < maxAttempts (3): package rescheduled, route advances.
        //   - If attemptCount >= maxAttempts: package → returned, deliverer gets
        //     "return_packages_to_branch" instruction.
        //   - Stop is failed via route.failStop().
        //   - Supervisor and branch rooms notified.
        socket.on("fail_delivery_attempt", async (data: {
          routeId:     string;
          stopIndex:   number;
          coordinates: [number, number];
          reason:      string;
          issueType?:  "customer_unavailable" | "wrong_address" | "other";
        }) => {
          try {
            if (!data?.routeId || !data?.reason) {
              socket.emit("route_error", { code: "MISSING_DATA", message: "routeId and reason are required." });
              return;
            }
            if (!data?.coordinates || data.coordinates.length !== 2) {
              socket.emit("route_error", { code: "NO_COORDINATES", message: "Current coordinates are required." });
              return;
            }

            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Deliverer profile not found." });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedDelivererId: deliverer._id,
              status: "active",
            });
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }

            if (data.stopIndex !== route.currentStopIndex) {
              socket.emit("route_error", {
                code: "WRONG_STOP",
                message: `Expected stop ${route.currentStopIndex}, received ${data.stopIndex}.`,
                expectedStopIndex: route.currentStopIndex,
              });
              return;
            }

            const stop = route.stops[data.stopIndex];
            if (!stop || !stop.packageIds[0]) {
              socket.emit("route_error", { code: "STOP_NOT_FOUND", message: "Stop or package not found." });
              return;
            }

            // Proximity check: must prove they were actually there
            const stopCoords = stop.location.coordinates;
            const distanceMeters = this.calculateDistance(data.coordinates, stopCoords) * 1000;
            if (distanceMeters > 50) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be within 50m of the delivery address to record a failed attempt. Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: 50,
              });
              return;
            }

            const packageId = stop.packageIds[0].toString();
            const pkg = await PackageModel.findById(packageId);
            if (!pkg) {
              socket.emit("route_error", { code: "PACKAGE_NOT_FOUND", message: "Package not found." });
              return;
            }

            // Add issue to package and update status to failed_delivery
            await pkg.updateStatus(
              "failed_delivery_attempt",
              deliverer.userId,
              pkg.currentBranchId,
              data.reason
            );

            // Update payment status
            const updatedPkgAfterFail = await PackageModel.findById(packageId).lean();
            const attemptsExhausted = (updatedPkgAfterFail?.attemptCount ?? 0) >= (updatedPkgAfterFail?.maxAttempts ?? 3);

            await PaymentModel.findOneAndUpdate(
              { packageId: packageId },
              {
                $set: {
                  status: attemptsExhausted ? 'failed' : 'pending',
                  delivererId: deliverer.userId
                }
              }
            );

            if (data.issueType) {
              await pkg.addIssue(
                data.issueType,
                data.reason,
                deliverer.userId,
                "medium"
              );
            }

            // Clean up OTP for this stop (they didn't use it)
            this.deliveryOTPs.delete(`delivery_otp_${packageId}`);

            // ── Fail the stop on the route (advances currentStopIndex) ──────────
            await route.failStop(
              data.stopIndex,
              data.reason,
              [new mongoose.Types.ObjectId(packageId)]
            );

            // Update deliverer stats
            await DelivererModel.findByIdAndUpdate(deliverer._id, {
              $inc: { totalDeliveries: 1, failedDeliveries: 1 },
              lastActiveAt: new Date(),
            });

            // Re-fetch fresh package to get updated attemptCount
            const updatedPkg = await PackageModel.findById(packageId).lean();
            const attemptsLeft = (updatedPkg?.maxAttempts ?? 3) - (updatedPkg?.attemptCount ?? 0);
            const maxReached   = (updatedPkg?.attemptCount ?? 0) >= (updatedPkg?.maxAttempts ?? 3);

            const routeRoom = this.getRouteRoom(data.routeId);

            // ── REQUEUE: move failed stop to the end of the route ────────────────
            let requeuedStopIndex: number | null = null;

            if (!maxReached) {
              const requeuedStop = {
                clientId:       stop.clientId,
                location:       stop.location,
                address:        stop.address,
                packageIds:     stop.packageIds,
                action:         stop.action,
                status:         "pending" as const,
                order:          route.stops.length + 1,
                expectedArrival: undefined,
                actualArrival:   undefined,
                completedPackages: [],
                failedPackages:    [],
                skippedPackages:   [],
                ...(stop.branchId ? { branchId: stop.branchId } : {}),
              };

              route.stops.push(requeuedStop as any);
              await route.save();

              requeuedStopIndex = route.stops.length - 1;

              console.log(
                `[Socket] Deliverer ${userId} — failed stop ${data.stopIndex} requeued ` +
                `as stop ${requeuedStopIndex} (package ${packageId}, ` +
                `attempt ${updatedPkg?.attemptCount}/${updatedPkg?.maxAttempts})`
              );
            }

            // ── Notify package tracking room ─────────────────────────────────────
            this.io.to(this.getPackageRoom(packageId)).emit("package_delivery_failed", {
              packageId,
              attemptCount:     updatedPkg?.attemptCount,
              maxAttempts:      updatedPkg?.maxAttempts,
              attemptsLeft,
              nextAttemptDate:  updatedPkg?.nextAttemptDate,
              requeuedAtStop:   requeuedStopIndex,
              reason:           data.reason,
              message: maxReached
                ? "All delivery attempts exhausted. Package will be returned."
                : `Delivery attempt failed. Your deliverer will retry after completing remaining stops.`,
              timestamp: new Date(),
            });

            // ── Notify branch / supervisor ────────────────────────────────────────
            this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit("deliverer_delivery_failed", {
              routeId:        data.routeId,
              delivererId:    deliverer._id,
              stopIndex:      data.stopIndex,
              packageId,
              attemptCount:   updatedPkg?.attemptCount,
              maxAttempts:    updatedPkg?.maxAttempts,
              maxReached,
              requeuedAtStop: requeuedStopIndex,
              reason:         data.reason,
              timestamp: new Date(),
            });

            // ── Determine what comes next for the deliverer ───────────────────────
            const totalStopsNow = route.stops.length;
            const hasNextStop   = route.currentStopIndex < totalStopsNow;
            const nextStop      = hasNextStop ? route.stops[route.currentStopIndex] : null;
            const isNowTrulyLastStop = !hasNextStop;

            if (maxReached) {
              this.deliveryOTPs.delete(`delivery_otp_${packageId}`);

              // Notify branch to expect the returned package
              this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit("package_requires_return", {
                packageId,
                trackingNumber: updatedPkg?.trackingNumber,
                delivererId:    deliverer._id,
                attemptCount:   updatedPkg?.attemptCount,
                reason:         data.reason,
                timestamp: new Date(),
              });

              if (isNowTrulyLastStop) {
                await route.completeRoute(`Last stop failed (max attempts): ${data.reason}`);
                await DelivererModel.findByIdAndUpdate(deliverer._id, {
                  availabilityStatus: "on_route",
                  currentRouteId:     route._id,
                  lastActiveAt: new Date(),
                });
                socket.emit("delivery_route_completed", {
                  routeId:             data.routeId,
                  routeNumber:         route.routeNumber,
                  status:              "completed",
                  hasPackagesToReturn: true,
                  message: "Route finished. Please return the failed package to your branch.",
                  timestamp: new Date(),
                });
              } else {
                if (nextStop) {
                  await this.generateAndSendDeliveryOTP(route, route.currentStopIndex, data.routeId);
                }
                socket.emit("delivery_attempt_failed", {
                  ...this.buildFailedStopPayload(data.routeId, data.stopIndex, packageId, data.reason, updatedPkg, distanceMeters),
                  maxReached:      true,
                  requiresReturn:  true,
                  requeuedAtStop:  null,
                  nextStop: nextStop ? {
                    stopIndex:   route.currentStopIndex,
                    stopId:      nextStop._id,
                    clientId:    nextStop.clientId,
                    packageId:   nextStop.packageIds[0],
                    address:     nextStop.address,
                    location:    nextStop.location.coordinates,
                    otpSent:     true,
                  } : null,
                  remainingStops: totalStopsNow - route.currentStopIndex,
                  message: "Maximum attempts reached. Package will be returned to branch. Continuing to next stop.",
                  timestamp: new Date(),
                });
                this.io.to(routeRoom).emit("delivery_stop_failed", {
                  routeId: data.routeId, stopIndex: data.stopIndex, packageId, reason: data.reason, timestamp: new Date(),
                });
              }
            } else {
              if (nextStop) {
                await this.generateAndSendDeliveryOTP(route, route.currentStopIndex, data.routeId);
              }

              socket.emit("delivery_attempt_failed", {
                ...this.buildFailedStopPayload(data.routeId, data.stopIndex, packageId, data.reason, updatedPkg, distanceMeters),
                maxReached:      false,
                requiresReturn:  false,
                requeuedAtStop:  requeuedStopIndex,
                nextStop: nextStop ? {
                  stopIndex:   route.currentStopIndex,
                  stopId:      nextStop._id,
                  clientId:    nextStop.clientId,
                  packageId:   nextStop.packageIds[0],
                  address:     nextStop.address,
                  location:    nextStop.location.coordinates,
                  isRetry:     route.currentStopIndex === requeuedStopIndex,
                  otpSent:     true,
                } : null,
                remainingStops: totalStopsNow - route.currentStopIndex,
                message: nextStop
                  ? `Attempt recorded. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining. ` +
                    `This stop has been moved to position ${requeuedStopIndex! + 1}. Proceeding to next stop.`
                  : "All stops complete.",
                timestamp: new Date(),
              });

              this.io.to(routeRoom).emit("delivery_stop_failed", {
                routeId:        data.routeId,
                stopIndex:      data.stopIndex,
                packageId,
                requeuedAtStop: requeuedStopIndex,
                reason:         data.reason,
                timestamp: new Date(),
              });
            }

            console.log(
              `[Socket] Deliverer ${userId} failed delivery at stop ${data.stopIndex}. ` +
              `Attempts: ${updatedPkg?.attemptCount}/${updatedPkg?.maxAttempts}. ` +
              (maxReached ? "Max reached — return required." : `Requeued at stop ${requeuedStopIndex}.`)
            );
          } catch (err: any) {
            console.error("[Socket] fail_delivery_attempt failed:", err);
            socket.emit("route_error", { code: "FAIL_DELIVERY_FAILED", message: err.message || "Failed to record delivery failure." });
          }
        });

        // ── resend_delivery_otp ──────────────────────────────────────────────
        // Deliverer can request a fresh OTP if the client claims they didn't
        // receive the SMS. Generates a new 6-digit code and re-sends it.
        socket.on("resend_delivery_otp", async (data: {
          routeId:   string;
          stopIndex: number;
        }) => {
          try {
            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) return;

            const route = await RouteModel.findOne({
              _id: data?.routeId,
              assignedDelivererId: deliverer._id,
              status: "active",
            }).lean();
            if (!route) {
              socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "Active route not found." });
              return;
            }
            if (data.stopIndex !== route.currentStopIndex) {
              socket.emit("route_error", { code: "WRONG_STOP", message: "Can only resend OTP for the current stop." });
              return;
            }

            const stop = route.stops[data.stopIndex];
            if (!stop?.packageIds[0]) {
              socket.emit("route_error", { code: "STOP_NOT_FOUND", message: "Stop or package not found." });
              return;
            }

            // Delete old OTP and generate a new one
            const packageId = stop.packageIds[0].toString();
            this.deliveryOTPs.delete(`delivery_otp_${packageId}`);
            await this.generateAndSendDeliveryOTP(route as any, data.stopIndex, data.routeId);

            socket.emit("delivery_otp_resent", {
              routeId:   data.routeId,
              stopIndex: data.stopIndex,
              packageId,
              message: "A new OTP has been sent to the client.",
              timestamp: new Date(),
            });
          } catch (err: any) {
            console.error("[Socket] resend_delivery_otp failed:", err);
            socket.emit("route_error", { code: "RESEND_OTP_FAILED", message: "Failed to resend OTP." });
          }
        });

        // ── return_package_to_branch ─────────────────────────────────────────
        // Deliverer confirms they have physically returned a failed package to branch.
        socket.on("return_package_to_branch", async (data: {
          packageId:   string;
          branchId:    string;
          coordinates: [number, number];
          notes?:      string;
        }) => {
          try {
            if (!data?.packageId || !data?.branchId) {
              socket.emit("route_error", { code: "MISSING_DATA", message: "packageId and branchId are required." });
              return;
            }
            if (!data?.coordinates || data.coordinates.length !== 2) {
              socket.emit("route_error", { code: "NO_COORDINATES", message: "Current coordinates are required." });
              return;
            }

            const deliverer = await DelivererModel.findOne({ userId }).lean();
            if (!deliverer) {
              socket.emit("route_error", { code: "NOT_FOUND", message: "Deliverer profile not found." });
              return;
            }

            const pkg = await PackageModel.findOne({
              _id: data.packageId,
              assignedDelivererId: deliverer._id,
            });
            if (!pkg) {
              socket.emit("route_error", { code: "PACKAGE_NOT_FOUND", message: "Package not found or not assigned to you." });
              return;
            }

            // Fetch branch location for proximity check
            const BranchModel = (await import("../models/branch.model")).default;
            const branch = await BranchModel.findById(data.branchId).select("location name").lean();
            if (!branch || !(branch as any).location) {
              socket.emit("route_error", { code: "BRANCH_NOT_FOUND", message: "Branch location not available." });
              return;
            }

            const branchCoords = (branch as any).location.coordinates as [number, number];
            const distanceMeters = this.calculateDistance(data.coordinates, branchCoords) * 1000;
            if (distanceMeters > 50) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be at the branch to confirm the return (within 50m). Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: 50,
              });
              return;
            }

            // Initiate return if not already marked
            if (pkg.status !== "returned") {
              await pkg.initiateReturn(
                "Maximum delivery attempts exceeded",
                undefined,
                data.notes
              );
            } else {
              // Already returned — just update the tracking history note
              pkg.trackingHistory.push({
                status: "returned",
                branchId: new mongoose.Types.ObjectId(data.branchId),
                userId:   deliverer.userId,
                notes:    data.notes || "Package physically returned to branch",
                timestamp: new Date(),
              } as any);
              await pkg.save();
            }

            // Free deliverer if this was the last package to return
            await DelivererModel.findByIdAndUpdate(deliverer._id, {
              availabilityStatus: "available",
              currentRouteId:     null,
              lastActiveAt: new Date(),
            });

            // Notify branch
            this.io.to(this.getBranchRoom(data.branchId)).emit("package_returned_to_branch", {
              packageId:      data.packageId,
              trackingNumber: pkg.trackingNumber,
              delivererId:    deliverer._id,
              branchId:       data.branchId,
              notes:          data.notes,
              timestamp: new Date(),
            });

            // Notify package room (client/sender)
            this.io.to(this.getPackageRoom(data.packageId)).emit("package_status_update", {
              packageId: data.packageId,
              status:    "returned",
              message:   "Package has been returned to the branch after failed delivery attempts.",
              timestamp: new Date(),
            });

            socket.emit("return_confirmed", {
              packageId:      data.packageId,
              trackingNumber: pkg.trackingNumber,
              branchId:       data.branchId,
              distanceMeters: Math.round(distanceMeters),
              message: "Package return confirmed. You are now available for a new route.",
              timestamp: new Date(),
            });

            console.log(`[Socket] Deliverer ${userId} returned package ${data.packageId} to branch ${data.branchId}`);
          } catch (err: any) {
            console.error("[Socket] return_package_to_branch failed:", err);
            socket.emit("route_error", { code: "RETURN_FAILED", message: err.message || "Failed to confirm package return." });
          }
        });

        // ── join_delivery_route_room ─────────────────────────────────────────
        // Deliverer re-opens app mid-route and rejoins the room.
        socket.on("join_delivery_route_room", async (data: { routeId: string }) => {
          if (!data?.routeId) return;
          const deliverer = await DelivererModel.findOne({ userId }).lean();
          if (!deliverer) return;

          const route = await RouteModel.findOne({
            _id: data.routeId,
            assignedDelivererId: deliverer._id,
            status: { $in: ["active", "paused"] },
          }).lean();

          if (!route) {
            socket.emit("route_error", { code: "ROUTE_NOT_FOUND", message: "No active/paused route found." });
            return;
          }

          socket.join(this.getRouteRoom(data.routeId));
          const currentStop = route.stops[route.currentStopIndex];

          socket.emit("delivery_route_rejoined", {
            routeId:          data.routeId,
            routeNumber:      route.routeNumber,
            status:           route.status,
            currentStopIndex: route.currentStopIndex,
            totalStops:       route.stops.length,
            completedStops:   route.completedStops,
            currentStop: currentStop ? {
              stopId:      currentStop._id,
              clientId:    currentStop.clientId,
              packageId:   currentStop.packageIds[0],
              address:     currentStop.address,
              location:    currentStop.location.coordinates,
              status:      currentStop.status,
            } : null,
            timestamp: new Date(),
          });
        });

      } // end if (role === "deliverer")


      // ══════════════════════════════════════════════════════════════════════
      //  PACKAGE TRACKING  –  client subscribes to a package's live updates
      // ══════════════════════════════════════════════════════════════════════

      socket.on(
        "track_package",
        async (data: { packageId: string }) => {
          try {
            if (!data?.packageId) {
              socket.emit("track_package_error", { message: "packageId is required." });
              return;
            }

            const pkg = await PackageModel.findById(data.packageId).lean();
            if (!pkg) {
              socket.emit("track_package_error", { message: "Package not found." });
              return;
            }

            // Authorization: only the sender or the recipient's client can track
            const isAuthorized =
              role === "admin" ||
              role === "manager" ||
              role === "supervisor" ||
              (pkg.senderId?.toString() === userId) ||
              (role === "deliverer"   && (pkg as any).assignedDelivererId?.toString()  === userId) ||
              (role === "transporter" && (pkg as any).assignedTransporterId?.toString() === userId);

            if (!isAuthorized) {
              socket.emit("track_package_error", { message: "Not authorized to track this package." });
              return;
            }

            const room = this.getPackageRoom(data.packageId);
            socket.join(room);

            // Immediately push current state to the subscriber
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

            console.log(`[Socket] ${role} ${userId} is now tracking package ${data.packageId}`);
          } catch (error: any) {
            console.error("[Socket] Error subscribing to package tracking:", error);
            socket.emit("track_package_error", {
              message: "Failed to subscribe to package tracking.",
              error: error.message,
            });
          }
        }
      );

      socket.on(
        "untrack_package",
        (data: { packageId: string }) => {
          if (!data?.packageId) return;
          const room = this.getPackageRoom(data.packageId);
          socket.leave(room);
          console.log(`[Socket] ${role} ${userId} stopped tracking package ${data.packageId}`);
        }
      );

      // ── Manifest tracking (supervisors / managers can watch a manifest's live status)
      socket.on("track_manifest", async (data: { manifestId: string }) => {
        try {
          if (!data?.manifestId || !mongoose.Types.ObjectId.isValid(data.manifestId)) {
            socket.emit("track_manifest_error", { message: "Valid manifestId is required." });
            return;
          }

          const allowed = ["admin", "manager", "supervisor", "transporter"];
          if (!allowed.includes(role)) {
            socket.emit("track_manifest_error", { message: "Not authorized to track manifests." });
            return;
          }

          const manifest = await ManifestModel.findById(data.manifestId)
            .select("manifestCode status originBranchId destinationBranchId totalDeclaredWeight packageCount transportLeg")
            .lean();

          if (!manifest) {
            socket.emit("track_manifest_error", { message: "Manifest not found." });
            return;
          }

          socket.join(this.getManifestRoom(data.manifestId));

          socket.emit("manifest_status_update", {
            manifestId:          data.manifestId,
            manifestCode:        manifest.manifestCode,
            status:              manifest.status,
            originBranchId:      manifest.originBranchId,
            destinationBranchId: manifest.destinationBranchId,
            packageCount:        manifest.packageCount,
            totalWeight:         manifest.totalDeclaredWeight,
            departedAt:          manifest.transportLeg?.departedAt,
            arrivedAt:           manifest.transportLeg?.arrivedAt,
            timestamp: new Date(),
          });

          console.log(`[Socket] ${role} ${userId} tracking manifest ${data.manifestId}`);
        } catch (err: any) {
          console.error("[Socket] track_manifest failed:", err);
          socket.emit("track_manifest_error", { message: err.message });
        }
      });

      socket.on("untrack_manifest", (data: { manifestId: string }) => {
        if (!data?.manifestId) return;
        socket.leave(this.getManifestRoom(data.manifestId));
      });


      // ══════════════════════════════════════════════════════════════════════
      //  JOIN BRANCH ROOM  –  supervisor / manager joins a branch room to
      //  receive real-time events for that branch
      // ══════════════════════════════════════════════════════════════════════

      if (role === "supervisor" || role === "manager" || role === "admin") {
        socket.on(
          "join_branch_room",
          (data: { branchId: string }) => {
            if (!data?.branchId) return;
            const room = this.getBranchRoom(data.branchId);
            socket.join(room);
            socket.emit("joined_branch_room", { branchId: data.branchId, room });
            console.log(`[Socket] ${role} ${userId} joined branch room ${room}`);
          }
        );

        socket.on(
          "leave_branch_room",
          (data: { branchId: string }) => {
            if (!data?.branchId) return;
            socket.leave(this.getBranchRoom(data.branchId));
          }
        );
      }


      // ══════════════════════════════════════════════════════════════════════
      //  DISCONNECT
      // ══════════════════════════════════════════════════════════════════════

      socket.on("disconnect", async (reason) => {
        console.log(`[Socket] Disconnected: userId=${userId} role=${role} reason=${reason}`);

        this.unregisterSocket(userId, role);

        if (role === "deliverer" || role === "transporter") {
          // ── Grace period: wait 30s before treating as truly offline ────────
          const timer = setTimeout(async () => {
            this.disconnectTimers.delete(userId);

            try {
              if (role === "deliverer") {
                await DelivererModel.findOneAndUpdate(
                  { userId },
                  { isOnline: false, lastActiveAt: new Date() }
                );
                await this.broadcastOnlineStatus(userId, role, false);
                await this.notifyDelivererOfflineToTrackers(userId);

              } else if (role === "transporter") {
                await TransporterModel.findOneAndUpdate(
                  { userId },
                  { isOnline: false, lastActiveAt: new Date() }
                );
                await this.broadcastOnlineStatus(userId, role, false);
                await this.notifyTransporterOfflineToBranch(userId);
              }

              await PresenceService.setOffline(userId, role).catch((err) =>
                console.error("[Socket] PresenceService.setOffline failed:", err.message)
              );

              console.log(`[Socket] Marked offline after grace period: userId=${userId} role=${role}`);
            } catch (err) {
              console.error("[Socket] Error on disconnect cleanup:", err);
            }
          }, 30000);

          this.disconnectTimers.set(userId, timer);
          console.log(`[Socket] Grace period started: userId=${userId} (30s to reconnect)`);
        }
      });
    });
  }


  // ─── Role-based Room Joining on Connect ───────────────────────────────────

  private async joinRoleRooms(
    socket: AuthenticatedSocket,
    userId: string,
    role: DeliveryUserRole
  ): Promise<void> {
    try {
      if (role === "deliverer") {
        const deliverer = await DelivererModel.findOne({ userId }).lean();
        if (deliverer) {
          socket.join(this.getBranchRoom(deliverer.branchId.toString()));
          socket.join(this.getCompanyRoom(deliverer.companyId.toString()));
        }
      } else if (role === "transporter") {
        const transporter = await TransporterModel.findOne({ userId }).lean();
        if (transporter) {
          socket.join(this.getCompanyRoom(transporter.companyId.toString()));
          if (transporter.currentBranchId) {
            socket.join(this.getBranchRoom(transporter.currentBranchId.toString()));
          }
        }
      } else if (role === "supervisor") {
        const supervisor = await SupervisorModel.findOne({ userId }).select("branchId companyId").lean();
        if (supervisor) {
          socket.join(this.getBranchRoom(supervisor.branchId.toString()));
          socket.join(this.getCompanyRoom(supervisor.companyId.toString()));
        }
      } else if (role === "freelancer") {
        const freelancer = await FreelancerModel.findOne({ userId }).select("companyId defaultOriginBranchId").lean();
        if (freelancer) {
          socket.join(this.getCompanyRoom(freelancer.companyId.toString()));
          if (freelancer.defaultOriginBranchId) {
            socket.join(this.getBranchRoom(freelancer.defaultOriginBranchId.toString()));
          }
        }
      }
    } catch (err) {
      console.error("[Socket] Error joining role rooms:", err);
    }
  }


  // ─── Socket Registry Helpers ──────────────────────────────────────────────

  private registerSocket(userId: string, role: DeliveryUserRole, socketId: string): void {
    switch (role) {
      case "deliverer":   this.delivererSockets.set(userId, socketId);   break;
      case "transporter": this.transporterSockets.set(userId, socketId); break;
      case "client":      this.clientSockets.set(userId, socketId);      break;
      case "freelancer":  this.freelancerSockets.set(userId, socketId);  break;
      case "supervisor":  this.supervisorSockets.set(userId, socketId);  break;
      case "manager":     this.managerSockets.set(userId, socketId);     break;
      case "admin":       this.adminSockets.set(userId, socketId);       break;
    }
  }

  private unregisterSocket(userId: string, role: DeliveryUserRole): void {
    switch (role) {
      case "deliverer":   this.delivererSockets.delete(userId);   break;
      case "transporter": this.transporterSockets.delete(userId); break;
      case "client":      this.clientSockets.delete(userId);      break;
      case "freelancer":  this.freelancerSockets.delete(userId);  break;
      case "supervisor":  this.supervisorSockets.delete(userId);  break;
      case "manager":     this.managerSockets.delete(userId);     break;
      case "admin":       this.adminSockets.delete(userId);       break;
    }
  }


  // ─── Broadcast: online / offline status ───────────────────────────────────

  private async broadcastOnlineStatus(
    userId: string,
    role: DeliveryUserRole,
    isOnline: boolean
  ): Promise<void> {
    try {
      if (role === "deliverer") {
        const deliverer = await DelivererModel.findOne({ userId }).lean();
        if (!deliverer) return;

        this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit(
          isOnline ? "deliverer_online" : "deliverer_offline",
          {
            userId,
            delivererId: deliverer._id,
            branchId: deliverer.branchId,
            availabilityStatus: deliverer.availabilityStatus,
            timestamp: new Date(),
          }
        );
      } else if (role === "transporter") {
        const transporter = await TransporterModel.findOne({ userId }).lean();
        if (!transporter) return;

        this.io.to(this.getCompanyRoom(transporter.companyId.toString())).emit(
          isOnline ? "transporter_online" : "transporter_offline",
          {
            userId,
            transporterId: transporter._id,
            companyId: transporter.companyId,
            availabilityStatus: transporter.availabilityStatus,
            timestamp: new Date(),
          }
        );
      }
    } catch (err) {
      console.error("[Socket] Error broadcasting online status:", err);
    }
  }


  // ─── Broadcast: deliverer location to package tracking rooms ──────────────

  private async broadcastDelivererLocation(
    delivererUserId: string,
    coordinates: [number, number]
  ): Promise<void> {
    try {
      const packages = await PackageModel.find({
        assignedDelivererId: delivererUserId,
        status: "out_for_delivery",
      })
        .select("_id clientId")
        .lean();

      for (const pkg of packages) {
        const room = this.getPackageRoom(pkg._id.toString());
        this.io.to(room).emit("deliverer_location_update", {
          packageId: pkg._id,
          delivererId: delivererUserId,
          coordinates,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error("[Socket] Error broadcasting deliverer location:", err);
    }
  }


  // ─── Broadcast: transporter location to relevant branch rooms ─────────────

  /**
   * Broadcasts transporter location to:
   *  - The branch room of their currentBranchId (unchanged)
   *  - Package rooms for packages in transit (legacy transporter routes)
   *  - Manifest rooms for manifests in transit (hub_to_hub routes)
   */
  private async broadcastTransporterLocation(
    transporterUserId: string,
    coordinates: [number, number]
  ): Promise<void> {
    try {
      const transporter = await TransporterModel.findOne({ userId: transporterUserId })
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

      // Legacy transporter routes — broadcast to package rooms
      const packages = await PackageModel.find({
        assignedTransporterId: transporterUserId,
        status: "in_transit_to_branch",
      })
        .select("_id")
        .lean();

      for (const pkg of packages) {
        this.io.to(this.getPackageRoom(pkg._id.toString())).emit("transporter_location_update", {
          packageId: pkg._id,
          transporterId: transporter._id,
          coordinates,
          timestamp: new Date(),
        });
      }

      // Hub_to_hub routes — broadcast to manifest rooms
      const manifests = await ManifestModel.find({
        "transportLeg.transporterId": transporter._id,
        status: "in_transit",
      })
        .select("_id manifestCode")
        .lean();

      for (const m of manifests) {
        this.io.to(this.getManifestRoom(m._id.toString())).emit("transporter_location_update", {
          manifestId:   m._id,
          manifestCode: m.manifestCode,
          transporterId: transporter._id,
          coordinates,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error("[Socket] Error broadcasting transporter location:", err);
    }
  }


  // ─── Broadcast: deliverer availability change to active trackers ───────────

  private async notifyDelivererStatusToTrackers(
    delivererUserId: string,
    status: string
  ): Promise<void> {
    try {
      const packages = await PackageModel.find({
        assignedDelivererId: delivererUserId,
        status: { $in: ["out_for_delivery", "at_destination_branch"] },
      })
        .select("_id")
        .lean();

      for (const pkg of packages) {
        this.io.to(this.getPackageRoom(pkg._id.toString())).emit("deliverer_status_update", {
          packageId: pkg._id,
          delivererId: delivererUserId,
          availabilityStatus: status,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error("[Socket] Error notifying trackers about deliverer status:", err);
    }
  }


  // ─── Disconnect: notify trackers deliverer went offline ───────────────────

  private async notifyDelivererOfflineToTrackers(delivererUserId: string): Promise<void> {
    try {
      const packages = await PackageModel.find({
        assignedDelivererId: delivererUserId,
        status: "out_for_delivery",
      })
        .select("_id")
        .lean();

      for (const pkg of packages) {
        this.io.to(this.getPackageRoom(pkg._id.toString())).emit("deliverer_offline", {
          packageId: pkg._id,
          delivererId: delivererUserId,
          message: "Deliverer is temporarily offline.",
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error("[Socket] Error notifying offline deliverer to trackers:", err);
    }
  }


  // ─── Disconnect: notify branch that transporter went offline ──────────────

  private async notifyTransporterOfflineToBranch(transporterUserId: string): Promise<void> {
    try {
      const transporter = await TransporterModel.findOne({ userId: transporterUserId })
        .select("currentBranchId companyId availabilityStatus")
        .lean();

      if (!transporter) return;

      const target = transporter.currentBranchId
        ? this.getBranchRoom(transporter.currentBranchId.toString())
        : this.getCompanyRoom(transporter.companyId.toString());

      this.io.to(target).emit("transporter_offline", {
        transporterId: transporter._id,
        userId: transporterUserId,
        message: "Transporter is temporarily offline.",
        timestamp: new Date(),
      });
    } catch (err) {
      console.error("[Socket] Error notifying offline transporter to branch:", err);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  PUBLIC API  –  called from controllers / other services
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the socket ID for any connected user.
   */
  public getSocketId(userId: string, role: DeliveryUserRole): string | undefined {
    switch (role) {
      case "deliverer":   return this.delivererSockets.get(userId);
      case "transporter": return this.transporterSockets.get(userId);
      case "client":      return this.clientSockets.get(userId);
      case "freelancer":  return this.freelancerSockets.get(userId);
      case "supervisor":  return this.supervisorSockets.get(userId);
      case "manager":     return this.managerSockets.get(userId);
      case "admin":       return this.adminSockets.get(userId);
      default:            return undefined;
    }
  }

  /**
   * Emit an event directly to a specific user.
   */
  public emitToUser(
    userId: string,
    role: DeliveryUserRole,
    event: string,
    data: any
  ): void {
    const socketId = this.getSocketId(userId, role);
    if (socketId) {
      this.io.to(socketId).emit(event, data);
    }
  }

  /**
   * Emit an event to every socket in a branch room
   * (all deliverers + supervisors that joined it).
   */
  public emitToBranch(branchId: string, event: string, data: any): void {
    this.io.to(this.getBranchRoom(branchId)).emit(event, data);
  }

  /**
   * Emit an event to every socket in a company room.
   */
  public emitToCompany(companyId: string, event: string, data: any): void {
    this.io.to(this.getCompanyRoom(companyId)).emit(event, data);
  }

  /**
   * Notify everyone tracking a package about a status change.
   * Call this from your package controller / service whenever status changes.
   */
  public emitPackageStatusUpdate(
    packageId: string,
    payload: {
      status: string;
      currentBranchId?: string;
      assignedDelivererId?: string;
      assignedTransporterId?: string;
      estimatedDeliveryTime?: Date;
      notes?: string;
    }
  ): void {
    this.io.to(this.getPackageRoom(packageId)).emit("package_status_update", {
      packageId,
      ...payload,
      timestamp: new Date(),
    });
  }

  /**
   * Emit a manifest status update to everyone tracking that manifest.
   * Call this from controllers when manifest status changes outside the socket flow.
   */
  public emitManifestStatusUpdate(
    manifestId: string,
    payload: {
      status: string;
      departedAt?: Date;
      arrivedAt?: Date;
      transporterId?: string;
    }
  ): void {
    this.io.to(this.getManifestRoom(manifestId)).emit("manifest_status_update", {
      manifestId,
      ...payload,
      timestamp: new Date(),
    });
  }

  /**
   * Assign a deliverer to a package delivery session and notify both parties.
   * Call this when a package is dispatched (out_for_delivery).
   */
  public async startDeliverySession(
    packageId: string,
    delivererUserId: string,
    clientUserId?: string
  ): Promise<void> {
    try {
      this.activeDeliveries.set(packageId, {
        packageId,
        delivererId: delivererUserId,
        clientId: clientUserId,
      });

      const delivererSocketId = this.delivererSockets.get(delivererUserId);
      if (delivererSocketId) {
        const delivererSocket = this.io.sockets.sockets.get(delivererSocketId);
        delivererSocket?.join(this.getPackageRoom(packageId));
      }

      this.emitToUser(delivererUserId, "deliverer", "delivery_assigned", {
        packageId,
        timestamp: new Date(),
      });

      if (clientUserId) {
        this.emitToUser(clientUserId, "client", "package_out_for_delivery", {
          packageId,
          delivererId: delivererUserId,
          message: "Your package is on the way!",
          timestamp: new Date(),
        });
      }

      console.log(`[Socket] Delivery session started: package=${packageId} deliverer=${delivererUserId}`);
    } catch (err) {
      console.error("[Socket] Error starting delivery session:", err);
    }
  }

  /**
   * End a delivery session (delivered, failed, returned …).
   * Call this whenever the package reaches a terminal or rescheduled state.
   */
  public async endDeliverySession(
    packageId: string,
    outcome: "delivered" | "failed_delivery" | "returned" | "rescheduled"
  ): Promise<void> {
    try {
      const session = this.activeDeliveries.get(packageId);

      this.io.to(this.getPackageRoom(packageId)).emit("delivery_session_ended", {
        packageId,
        outcome,
        timestamp: new Date(),
      });

      if (session) {
        const delivererSocketId = this.delivererSockets.get(session.delivererId);
        if (delivererSocketId) {
          this.io.sockets.sockets.get(delivererSocketId)?.leave(this.getPackageRoom(packageId));
        }
      }

      this.activeDeliveries.delete(packageId);
      console.log(`[Socket] Delivery session ended: package=${packageId} outcome=${outcome}`);
    } catch (err) {
      console.error("[Socket] Error ending delivery session:", err);
    }
  }

  /**
   * Start a branch-to-branch transit session (transporter picked up packages).
   */
  public async startTransitSession(
    packageId: string,
    transporterUserId: string,
    originBranchId: string,
    destinationBranchId: string
  ): Promise<void> {
    try {
      this.activeTransits.set(packageId, {
        packageId,
        transporterId: transporterUserId,
        originBranchId,
        destinationBranchId,
      });

      const transporterSocketId = this.transporterSockets.get(transporterUserId);
      if (transporterSocketId) {
        this.io.sockets.sockets.get(transporterSocketId)?.join(this.getPackageRoom(packageId));
      }

      const payload = {
        packageId,
        transporterId: transporterUserId,
        originBranchId,
        destinationBranchId,
        timestamp: new Date(),
      };
      this.emitToBranch(originBranchId, "package_in_transit", payload);
      this.emitToBranch(destinationBranchId, "package_incoming", payload);

      console.log(
        `[Socket] Transit session started: package=${packageId} transporter=${transporterUserId} ` +
        `${originBranchId} → ${destinationBranchId}`
      );
    } catch (err) {
      console.error("[Socket] Error starting transit session:", err);
    }
  }

  /**
   * End a transit session when the package arrives at the destination branch.
   */
  public async endTransitSession(packageId: string): Promise<void> {
    try {
      const session = this.activeTransits.get(packageId);

      this.io.to(this.getPackageRoom(packageId)).emit("transit_session_ended", {
        packageId,
        timestamp: new Date(),
      });

      if (session) {
        this.emitToBranch(session.destinationBranchId, "package_arrived", {
          packageId,
          transporterId: session.transporterId,
          timestamp: new Date(),
        });

        const transporterSocketId = this.transporterSockets.get(session.transporterId);
        if (transporterSocketId) {
          this.io.sockets.sockets.get(transporterSocketId)?.leave(this.getPackageRoom(packageId));
        }
      }

      this.activeTransits.delete(packageId);
      console.log(`[Socket] Transit session ended: package=${packageId}`);
    } catch (err) {
      console.error("[Socket] Error ending transit session:", err);
    }
  }

  /**
   * Starts a manifest transit session (hub_to_hub).
   * Notifies both origin and destination hub rooms.
   */
  public async startManifestTransitSession(
    manifestId: string,
    manifestCode: string,
    transporterUserId: string,
    originBranchId: string,
    destinationBranchId: string
  ): Promise<void> {
    try {
      this.activeManifestTransits.set(manifestId, {
        manifestId,
        manifestCode,
        transporterUserId,
        originBranchId,
        destinationBranchId,
      });

      const transporterSocketId = this.transporterSockets.get(transporterUserId);
      if (transporterSocketId) {
        this.io.sockets.sockets.get(transporterSocketId)?.join(this.getManifestRoom(manifestId));
      }

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

      console.log(`[Socket] Manifest transit session started: manifest=${manifestCode} transporter=${transporterUserId} ${originBranchId} → ${destinationBranchId}`);
    } catch (err) {
      console.error("[Socket] Error starting manifest transit session:", err);
    }
  }

  /**
   * Ends a manifest transit session on arrival.
   */
  public async endManifestTransitSession(manifestId: string): Promise<void> {
    try {
      const session = this.activeManifestTransits.get(manifestId);

      this.io.to(this.getManifestRoom(manifestId)).emit("manifest_transit_ended", {
        manifestId,
        timestamp: new Date(),
      });

      if (session) {
        this.emitToBranch(session.destinationBranchId, "manifest_arrived", {
          manifestId,
          manifestCode: session.manifestCode,
          transporterUserId: session.transporterUserId,
          timestamp: new Date(),
        });

        const transporterSocketId = this.transporterSockets.get(session.transporterUserId);
        if (transporterSocketId) {
          this.io.sockets.sockets.get(transporterSocketId)?.leave(this.getManifestRoom(manifestId));
        }
      }

      this.activeManifestTransits.delete(manifestId);
      console.log(`[Socket] Manifest transit session ended: manifest=${manifestId}`);
    } catch (err) {
      console.error("[Socket] Error ending manifest transit session:", err);
    }
  }

  /**
   * Check whether a user is currently connected.
   */
  public isUserOnline(userId: string, role: DeliveryUserRole): boolean {
    return !!this.getSocketId(userId, role);
  }


  // --- OTP helper: generate 6-digit code, store in memory, send via SMS ---

  private async generateAndSendDeliveryOTP(
    route: any,
    stopIndex: number,
    routeId: string
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
      const trackingNumber = (pkg as any).trackingNumber;

      if (!recipientPhone) {
        console.warn(`[OTP] No recipient phone for package ${packageId} -- OTP not sent`);
        return;
      }

      // 6-digit OTP, valid 10 minutes
      const code       = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt  = Date.now() + 10 * 60 * 1000;
      const routeObjId = new mongoose.Types.ObjectId(routeId);

      // Store in memory for fast lookup during complete_delivery
      this.deliveryOTPs.set(`delivery_otp_${packageId}`, { code, expiresAt });

      // Persist on the package so the code survives a server restart
      await PackageModel.findByIdAndUpdate(packageId, {
        $set: {
          "deliveryOtp.code":        code,
          "deliveryOtp.expiresAt":   new Date(expiresAt),
          "deliveryOtp.stopIndex":   stopIndex,
          "deliveryOtp.routeId":     routeObjId,
          "deliveryOtp.generatedAt": new Date(),
          "deliveryOtp.verified":    false,
        },
      });

      // Send via Twilio SMS
      const smsSent = await sendSMS({
        to:      recipientPhone,
        message: `Your delivery code for package ${trackingNumber} is: ${code}. Valid for 10 minutes. Do not share this code.`,
      });

      if (!smsSent) {
        console.error(`[OTP] SMS failed for package ${packageId} to ${recipientPhone}`);
      } else {
        console.log(`[OTP] SMS sent to ${recipientPhone} for package ${packageId}`);
      }
    } catch (err) {
      console.error("[Socket] generateAndSendDeliveryOTP failed:", err);
    }
  }


  // --- Helper: build fail_delivery_attempt payload -------------------------

  private buildFailedStopPayload(
    routeId:        string,
    stopIndex:      number,
    packageId:      string,
    reason:         string,
    pkg:            any,
    distanceMeters: number
  ): Record<string, any> {
    const attemptsLeft = (pkg?.maxAttempts ?? 3) - (pkg?.attemptCount ?? 0);
    const maxReached   = (pkg?.attemptCount ?? 0) >= (pkg?.maxAttempts ?? 3);
    return {
      routeId,
      stopIndex,
      packageId,
      attemptCount:    pkg?.attemptCount,
      maxAttempts:     pkg?.maxAttempts,
      attemptsLeft,
      maxReached,
      requiresReturn:  maxReached,
      nextAttemptDate: pkg?.nextAttemptDate,
      distanceMeters:  Math.round(distanceMeters),
      reason,
      timestamp: new Date(),
    };
  }




  public getConnectionStats(): Record<string, number> {
    return {
      deliverers:   this.delivererSockets.size,
      transporters: this.transporterSockets.size,
      clients:      this.clientSockets.size,
      freelancers:  this.freelancerSockets.size,
      supervisors:  this.supervisorSockets.size,
      managers:     this.managerSockets.size,
      admins:       this.adminSockets.size,
      total: (
        this.delivererSockets.size +
        this.transporterSockets.size +
        this.clientSockets.size +
        this.freelancerSockets.size +
        this.supervisorSockets.size +
        this.managerSockets.size +
        this.adminSockets.size
      ),
    };
  }
}