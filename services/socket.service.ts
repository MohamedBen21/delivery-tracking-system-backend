import { Server } from "socket.io";
import { AuthenticatedSocket } from "../middleware/socketAuth";
import mongoose from "mongoose";

import DelivererModel from "../models/deliverer.model";
import TransporterModel from "../models/transporter.model";
import ClientModel from "../models/client.model";
import SupervisorModel from "../models/supervisor.model";
import FreelancerModel from "../models/freelancer.model";
import PackageModel from "../models/package.model";
import RouteModel from "../models/route.model";
import { IUser } from "../models/user.model";



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
  private activeDeliveries: Map<string, ActiveDelivery>  = new Map();
  // packageId → active transit session (branch-to-branch)
  private activeTransits: Map<string, ActiveTransit>     = new Map();
  // packageId -> { code, expiresAt } -- in-memory, short-lived (10 min)
  private deliveryOTPs: Map<string, { code: string; expiresAt: number }> = new Map();




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


      //  LOCATION UPDATE


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

            const locationUpdate: LocationUpdateData = {
              userId,
              role,
              coordinates: data.coordinates,
              timestamp: new Date(),
            };

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
              timestamp: locationUpdate.timestamp,
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


      //  AVAILABILITY STATUS  (deliverer / transporter only)


      if (role === "deliverer") {
        socket.on(
          "change_availability",
          async (data: { status: "available" | "on_route" | "off_duty" | "on_break" | "maintenance" }) => {
            try {
              const allowedStatuses = ["available", "on_route", "off_duty", "on_break", "maintenance"];
              if (!data?.status || !allowedStatuses.includes(data.status)) {
                socket.emit("availability_change_error", { message: `Invalid status. Must be one of: ${allowedStatuses.join(", ")}` });
                return;
              }

              await DelivererModel.findOneAndUpdate(
                { userId },
                { availabilityStatus: data.status, lastActiveAt: new Date() }
              );

              // Notify packages that have this deliverer assigned (clients tracking their parcel)
              await this.notifyDelivererStatusToTrackers(userId, data.status);

              socket.emit("availability_change_success", {
                status: data.status,
                timestamp: new Date(),
              });

              console.log(`[Socket] Deliverer ${userId} changed availability → ${data.status}`);
            } catch (error: any) {
              console.error("[Socket] Error changing deliverer availability:", error);
              socket.emit("availability_change_error", {
                message: "Failed to update availability status.",
                error: error.message,
              });
            }
          }
        );
      }

      if (role === "transporter") {
        socket.on(
          "change_availability",
          async (data: { status: "available" | "on_route" | "off_duty" | "on_break" | "maintenance" }) => {
            try {
              const allowedStatuses = ["available", "on_route", "off_duty", "on_break", "maintenance"];
              if (!data?.status || !allowedStatuses.includes(data.status)) {
                socket.emit("availability_change_error", { message: `Invalid status. Must be one of: ${allowedStatuses.join(", ")}` });
                return;
              }

              await TransporterModel.findOneAndUpdate(
                { userId },
                { availabilityStatus: data.status, lastActiveAt: new Date() }
              );

              socket.emit("availability_change_success", {
                status: data.status,
                timestamp: new Date(),
              });

              console.log(`[Socket] Transporter ${userId} changed availability → ${data.status}`);
            } catch (error: any) {
              console.error("[Socket] Error changing transporter availability:", error);
              socket.emit("availability_change_error", {
                message: "Failed to update availability status.",
                error: error.message,
              });
            }
          }
        );
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

            // Notify supervisor branch room
            if (transporter.currentBranchId) {
              this.io.to(this.getBranchRoom(transporter.currentBranchId.toString())).emit("transporter_route_started", {
                routeId:       data.routeId,
                routeNumber:   route.routeNumber,
                transporterId: transporter._id,
                userId,
                totalStops:    route.stops.length,
                firstStop: route.stops[0] ? {
                  stopId:   route.stops[0]._id,
                  branchId: route.stops[0].branchId,
                  address:  route.stops[0].address,
                  location: route.stops[0].location.coordinates,
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
              status:           "active",
              currentStopIndex: 0,
              totalStops:       route.stops.length,
              currentStop: route.stops[0] ? {
                stopId:      route.stops[0]._id,
                branchId:    route.stops[0].branchId,
                address:     route.stops[0].address,
                location:    route.stops[0].location.coordinates,
                packageCount: route.stops[0].packageIds.length,
                order:       route.stops[0].order,
              } : null,
              scheduledEnd: route.scheduledEnd,
              timestamp: new Date(),
            });

            console.log(`[Socket] Transporter ${userId} started route ${data.routeId}`);
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
        //   3. Transporter must be within 50m of the stop location.
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

            // Proximity check: must be within 50m of the stop
            const stopCoords = stop.location.coordinates;
            const distanceMeters = this.calculateDistance(data.coordinates, stopCoords) * 1000;

            if (distanceMeters > 50) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be within 50m of the stop to mark arrival. Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: 50,
                stopLocation: stopCoords,
              });
              return;
            }

            // Mark arrived and record actualArrival
            stop.status        = "arrived";
            stop.actualArrival = new Date();
            await route.save();

            await TransporterModel.findByIdAndUpdate(transporter._id, { lastActiveAt: new Date() });

            // Notify the branch room (supervisor sees transporter arrived)
            if (stop.branchId) {
              this.io.to(this.getBranchRoom(stop.branchId.toString())).emit("transporter_arrived_at_branch", {
                routeId:        data.routeId,
                routeNumber:    route.routeNumber,
                transporterId:  transporter._id,
                stopIndex:      data.stopIndex,
                stopId:         stop._id,
                branchId:       stop.branchId,
                distanceMeters: Math.round(distanceMeters),
                packageCount:   stop.packageIds.length,
                timestamp: new Date(),
              });
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
              packages:       stop.packageIds,
              distanceMeters: Math.round(distanceMeters),
              timestamp: new Date(),
            });

            console.log(`[Socket] Transporter ${userId} arrived at stop ${data.stopIndex} (${Math.round(distanceMeters)}m away)`);
          } catch (err: any) {
            console.error("[Socket] arrived_at_stop failed:", err);
            socket.emit("route_error", { code: "ARRIVE_FAILED", message: err.message || "Failed to mark arrival." });
          }
        });

        // ── complete_stop ────────────────────────────────────────────────────
        // Transporter confirms packages are unloaded at this stop.
        // Conditions:
        //   1. Route status = active.
        //   2. stopIndex === route.currentStopIndex (enforces order).
        //   3. Stop status must be arrived / in_progress / pending.
        //   4. Transporter within 50m of the stop.
        //   5. All provided packageIds must belong to this stop.
        // If this is the last stop → route.completeRoute() fires automatically
        //   and the transporter receives a "route_completed" push notification.
        socket.on("complete_stop", async (data: {
          routeId:              string;
          stopIndex:            number;
          coordinates:          [number, number];
          completedPackageIds?: string[];
          failedPackageIds?:    string[];
          notes?:               string;
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

            // Proximity check: within 50m
            const stopCoords = stop.location.coordinates;
            const distanceMeters = this.calculateDistance(data.coordinates, stopCoords) * 1000;
            if (distanceMeters > 50) {
              socket.emit("route_error", {
                code: "TOO_FAR",
                message: `You must be within 50m of the stop to complete it. Current distance: ${Math.round(distanceMeters)}m.`,
                distanceMeters: Math.round(distanceMeters),
                requiredMeters: 50,
                stopLocation: stopCoords,
              });
              return;
            }

            // Validate all package IDs belong to this stop
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

            // If transporter sent no breakdown, treat all packages as completed
            const finalCompleted = completedOids.length > 0
              ? completedOids
              : (stop.packageIds as mongoose.Types.ObjectId[]);

            await route.completeStop(data.stopIndex, finalCompleted, failedOids, data.notes);

            const isLastStop   = data.stopIndex === route.stops.length - 1;
            const routeRoom    = this.getRouteRoom(data.routeId);
            const nextStop     = !isLastStop ? route.stops[data.stopIndex + 1] : null;

            if (isLastStop) {
              // ── All stops done: complete the entire route ────────────────
              await route.completeRoute(data.notes);

              // Free transporter
              await TransporterModel.findByIdAndUpdate(transporter._id, {
                availabilityStatus: "available",
                currentRouteId:     null,
                lastActiveAt: new Date(),
              });

              // Push completion notification directly to transporter's socket
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

              // Notify every branch the route touched
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

              // Notify company room (managers)
              this.io.to(this.getCompanyRoom(transporter.companyId.toString())).emit("transporter_route_completed", {
                routeId:           data.routeId,
                routeNumber:       route.routeNumber,
                transporterId:     transporter._id,
                userId,
                onTimePerformance: route.onTimePerformance,
                timestamp: new Date(),
              });

              // Broadcast to route room
              this.io.to(routeRoom).emit("route_completed", {
                routeId:    data.routeId,
                routeNumber: route.routeNumber,
                timestamp:  new Date(),
              });

              console.log(`[Socket] Transporter ${userId} COMPLETED route ${data.routeId}`);
            } else {
              // ── More stops remain ────────────────────────────────────────
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

              // Notify the branch just left
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

              // Notify the next branch that transporter is inbound
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

              // Broadcast to route room
              this.io.to(routeRoom).emit("stop_completed", {
                routeId:       data.routeId,
                stopIndex:     data.stopIndex,
                stopId:        stop._id,
                nextStopIndex: data.stopIndex + 1,
                timestamp: new Date(),
              });

              console.log(`[Socket] Transporter ${userId} completed stop ${data.stopIndex}/${route.stops.length - 1}`);
            }
          } catch (err: any) {
            console.error("[Socket] complete_stop failed:", err);
            socket.emit("route_error", { code: "COMPLETE_STOP_FAILED", message: err.message || "Failed to complete stop." });
          }
        });

        // ── fail_stop ────────────────────────────────────────────────────────
        // Transporter could not deliver packages at a stop (e.g. branch closed).
        // Advances currentStopIndex so the route continues.
        // If it's the last stop, the route is still completed.
        socket.on("fail_stop", async (data: {
          routeId:            string;
          stopIndex:          number;
          reason:             string;
          skippedPackageIds?: string[];
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

            const stop      = route.stops[data.stopIndex];
            const isLastStop = data.stopIndex === route.stops.length - 1;

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
              this.io.to(this.getBranchRoom(stop.branchId.toString())).emit("transporter_stop_failed", {
                routeId:       data.routeId,
                transporterId: transporter._id,
                stopId:        stop._id,
                branchId:      stop.branchId,
                reason:        data.reason,
                timestamp: new Date(),
              });
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

            socket.emit("route_resumed", {
              routeId:          data.routeId,
              currentStopIndex: route.currentStopIndex,
              currentStop: currentStop ? {
                stopId:      currentStop._id,
                branchId:    currentStop.branchId,
                address:     currentStop.address,
                location:    currentStop.location.coordinates,
                packageCount: currentStop.packageIds.length,
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

          socket.emit("route_rejoined", {
            routeId:          data.routeId,
            routeNumber:      route.routeNumber,
            status:           route.status,
            currentStopIndex: route.currentStopIndex,
            totalStops:       route.stops.length,
            completedStops:   route.completedStops,
            currentStop: currentStop ? {
              stopId:      currentStop._id,
              branchId:    currentStop.branchId,
              address:     currentStop.address,
              location:    currentStop.location.coordinates,
              status:      currentStop.status,
              packageCount: currentStop.packageIds.length,
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
                stopId:       firstStop._id,
                clientId:     firstStop.clientId,
                packageId:    firstStop.packageIds[0],
                address:      firstStop.address,
                location:     firstStop.location.coordinates,
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
              routeId:       data.routeId,
              delivererId:   deliverer._id,
              stopIndex:     data.stopIndex,
              stopId:        stop._id,
              clientId:      stop.clientId,
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

            // Complete the stop
            await route.completeStop(
              data.stopIndex,
              [new mongoose.Types.ObjectId(packageId)],
              [],
              data.notes
            );

            // Clean up OTP
            this.deliveryOTPs.delete(otpKey);

            // Update deliverer stats
            await DelivererModel.findByIdAndUpdate(deliverer._id, {
              $inc: { totalDeliveries: 1, successfulDeliveries: 1 },
              lastActiveAt: new Date(),
            });

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
            // The model's updateStatus increments attemptCount and sets nextAttemptDate
            await pkg.updateStatus(
              "failed_delivery",
              deliverer.userId,
              pkg.currentBranchId,
              data.reason
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

            // Fail the stop on the route
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

            const isLastStop   = data.stopIndex === route.stops.length - 1;
            const routeRoom    = this.getRouteRoom(data.routeId);

            // Notify package tracking room
            this.io.to(this.getPackageRoom(packageId)).emit("package_delivery_failed", {
              packageId,
              attemptCount:  updatedPkg?.attemptCount,
              maxAttempts:   updatedPkg?.maxAttempts,
              attemptsLeft,
              nextAttemptDate: updatedPkg?.nextAttemptDate,
              reason:        data.reason,
              message: maxReached
                ? "All delivery attempts exhausted. Package will be returned."
                : `Delivery attempt failed. We will try again on ${updatedPkg?.nextAttemptDate?.toLocaleDateString()}.`,
              timestamp: new Date(),
            });

            if (maxReached) {
              // Package exceeded max attempts — instruct deliverer to return it
              // Note: the package model pre-save already flipped status to 'returned'
              this.deliveryOTPs.delete(`delivery_otp_${packageId}`);

              socket.emit("delivery_attempt_failed", {
                routeId:       data.routeId,
                stopIndex:     data.stopIndex,
                packageId,
                attemptCount:  updatedPkg?.attemptCount,
                maxAttempts:   updatedPkg?.maxAttempts,
                maxReached:    true,
                requiresReturn: true,
                distanceMeters: Math.round(distanceMeters),
                message: "Maximum delivery attempts reached. Please return this package to your branch at the end of your route.",
                timestamp: new Date(),
              });

              // Notify branch immediately
              this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit("package_requires_return", {
                packageId,
                trackingNumber: updatedPkg?.trackingNumber,
                delivererId:    deliverer._id,
                attemptCount:   updatedPkg?.attemptCount,
                reason:         data.reason,
                timestamp: new Date(),
              });
            } else {
              // Still has attempts left — package rescheduled for tomorrow
              socket.emit("delivery_attempt_failed", {
                routeId:        data.routeId,
                stopIndex:      data.stopIndex,
                packageId,
                attemptCount:   updatedPkg?.attemptCount,
                maxAttempts:    updatedPkg?.maxAttempts,
                attemptsLeft,
                maxReached:     false,
                requiresReturn: false,
                nextAttemptDate: updatedPkg?.nextAttemptDate,
                distanceMeters: Math.round(distanceMeters),
                message: `Attempt recorded. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining. Package rescheduled.`,
                timestamp: new Date(),
              });
            }

            // Notify branch / supervisor room regardless
            this.io.to(this.getBranchRoom(deliverer.branchId.toString())).emit("deliverer_delivery_failed", {
              routeId:       data.routeId,
              delivererId:   deliverer._id,
              stopIndex:     data.stopIndex,
              packageId,
              attemptCount:  updatedPkg?.attemptCount,
              maxAttempts:   updatedPkg?.maxAttempts,
              maxReached,
              reason:        data.reason,
              timestamp: new Date(),
            });

            if (isLastStop) {
              // Last stop, route still completes
              await route.completeRoute(`Last stop failed: ${data.reason}`);
              await DelivererModel.findByIdAndUpdate(deliverer._id, {
                availabilityStatus: maxReached ? "on_route" : "available", // keep on_route if has package to return
                currentRouteId: maxReached ? route._id : null,
                lastActiveAt: new Date(),
              });
              socket.emit("delivery_route_completed", {
                routeId:    data.routeId,
                routeNumber: route.routeNumber,
                status:     "completed",
                hasPackagesToReturn: maxReached,
                message: maxReached
                  ? "Route finished. Please return the failed package to your branch."
                  : "Route completed.",
                timestamp: new Date(),
              });
            } else {
              // More stops remain — show next stop
              const nextStop = route.stops[data.stopIndex + 1];
              if (nextStop) {
                await this.generateAndSendDeliveryOTP(route, data.stopIndex + 1, data.routeId);
              }

              socket.emit("delivery_attempt_failed", {
                ...await this.buildFailedStopPayload(data.routeId, data.stopIndex, packageId, data.reason, updatedPkg, distanceMeters),
                nextStop: nextStop ? {
                  stopIndex:   data.stopIndex + 1,
                  stopId:      nextStop._id,
                  clientId:    nextStop.clientId,
                  packageId:   nextStop.packageIds[0],
                  address:     nextStop.address,
                  location:    nextStop.location.coordinates,
                  otpSent: true,
                } : null,
                remainingStops: route.stops.length - (data.stopIndex + 1),
              });

              this.io.to(routeRoom).emit("delivery_stop_failed", {
                routeId:   data.routeId,
                stopIndex: data.stopIndex,
                packageId,
                reason:    data.reason,
                timestamp: new Date(),
              });
            }

            console.log(`[Socket] Deliverer ${userId} failed delivery at stop ${data.stopIndex}. Attempts: ${updatedPkg?.attemptCount}/${updatedPkg?.maxAttempts}`);
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

        
      }

      // ══════════════════════════════════════════════════════════════════════
      //  DISCONNECT
      // ══════════════════════════════════════════════════════════════════════

      socket.on("disconnect", async () => {
        console.log(`[Socket] Disconnected: userId=${userId} role=${role} socketId=${socket.id}`);

        this.unregisterSocket(userId, role);

        // Mark offline in DB
        try {
          if (role === "deliverer") {
            // Do NOT forcibly change availabilityStatus on disconnect —
            // the deliverer may just be reconnecting. The last known status stays.
            await DelivererModel.findOneAndUpdate(
              { userId },
              { lastActiveAt: new Date() }
            );
            await this.broadcastOnlineStatus(userId, role, false);
          } else if (role === "transporter") {
            await TransporterModel.findOneAndUpdate(
              { userId },
              { lastActiveAt: new Date() }
            );
            await this.broadcastOnlineStatus(userId, role, false);
          }
        } catch (err) {
          console.error("[Socket] Error on disconnect cleanup:", err);
        }

        // Notify clients actively tracking a package this deliverer is on
        if (role === "deliverer") {
          await this.notifyDelivererOfflineToTrackers(userId);
        }

        // Notify branch room about transporter going offline
        if (role === "transporter") {
          await this.notifyTransporterOfflineToBranch(userId);
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

        // Notify the branch room (supervisors / managers)
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
      // Find all packages currently assigned to this deliverer and out for delivery
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

  private async broadcastTransporterLocation(
    transporterUserId: string,
    coordinates: [number, number]
  ): Promise<void> {
    try {
      const transporter = await TransporterModel.findOne({ userId: transporterUserId })
        .select("companyId currentBranchId currentRouteId")
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

      // Also push to packages in transit by this transporter
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
   * Assign a deliverer to a package delivery session and notify both parties.
   * Call this when a package is dispatched (out_for_delivery).
   */
  public async startDeliverySession(
    packageId: string,
    delivererUserId: string,
    clientUserId?: string
  ): Promise<void> {
    try {
      // Store in memory
      this.activeDeliveries.set(packageId, {
        packageId,
        delivererId: delivererUserId,
        clientId: clientUserId,
      });

      // Deliverer joins the package room for two-way pushes
      const delivererSocketId = this.delivererSockets.get(delivererUserId);
      if (delivererSocketId) {
        const delivererSocket = this.io.sockets.sockets.get(delivererSocketId);
        delivererSocket?.join(this.getPackageRoom(packageId));
      }

      // Notify the deliverer
      this.emitToUser(delivererUserId, "deliverer", "delivery_assigned", {
        packageId,
        timestamp: new Date(),
      });

      // Notify the client (if home delivery)
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

      // Notify room
      this.io.to(this.getPackageRoom(packageId)).emit("delivery_session_ended", {
        packageId,
        outcome,
        timestamp: new Date(),
      });

      // Remove deliverer from the room
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

      // Transporter joins the package room
      const transporterSocketId = this.transporterSockets.get(transporterUserId);
      if (transporterSocketId) {
        this.io.sockets.sockets.get(transporterSocketId)?.join(this.getPackageRoom(packageId));
      }

      // Notify origin and destination branch rooms
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
   * Check whether a user is currently connected.
   */
  public isUserOnline(userId: string, role: DeliveryUserRole): boolean {
    return !!this.getSocketId(userId, role);
  }

  /**
   * Return all connected users counts (useful for monitoring endpoints).
   */

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

      // 6-digit OTP, valid 10 minutes
      const code      = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 10 * 60 * 1000;

      this.deliveryOTPs.set(`delivery_otp_${packageId}`, { code, expiresAt });

      // Persist on the package for durability across restarts
      await PackageModel.findByIdAndUpdate(packageId, {
        $set: {
          "deliveryOtp.code":      code,
          "deliveryOtp.expiresAt": new Date(expiresAt),
          "deliveryOtp.stopIndex": stopIndex,
          "deliveryOtp.routeId":   routeId,
        },
      });

      const recipientPhone = (pkg as any).destination?.recipientPhone;
      const trackingNumber = (pkg as any).trackingNumber;

      if (recipientPhone) {
        // TODO: replace with your SMS provider (Twilio, Vonage, etc.)
        // await smsService.send(
        //   recipientPhone,
        //   `Your delivery OTP for package ${trackingNumber} is: ${code}. Valid for 10 minutes.`
        // );
        console.log(`[OTP] pkg=${packageId} phone=${recipientPhone} code=${code}`);
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