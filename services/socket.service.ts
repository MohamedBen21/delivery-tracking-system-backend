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
            // senderId covers both client and freelancer senders.
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
              currentRouteId: route._id,
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

            // Update package statuses for completed packages
            for (const pkgId of finalCompleted) {
              await PackageModel.findByIdAndUpdate(pkgId, {
                status: "at_destination_branch",
                currentBranchId: stop.branchId,
                updatedAt: new Date(),
              });
            }

            // Update package statuses for failed packages
            for (const pkgId of failedOids) {
              await PackageModel.findByIdAndUpdate(pkgId, {
                status: "failed_delivery",
                updatedAt: new Date(),
              });
            }

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



      } // end if (role === "transporter")

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
          // If transporter has an active route, join route room
          if (transporter.currentRouteId) {
            const route = await RouteModel.findById(transporter.currentRouteId).lean();
            if (route && ["active", "paused"].includes(route.status)) {
              socket.join(this.getRouteRoom(route._id.toString()));
            }
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
      case "deliverer":   
      this.delivererSockets.set(userId, socketId);   
      break;

      case "transporter": 
      this.transporterSockets.set(userId, socketId); 
      break;

      case "client":      
      this.clientSockets.set(userId, socketId);      
      break;

      case "freelancer":  
      this.freelancerSockets.set(userId, socketId);  
      break;

      case "supervisor":  
      this.supervisorSockets.set(userId, socketId);  
      break;

      case "manager":     
      this.managerSockets.set(userId, socketId);     
      break;

      case "admin":       
      this.adminSockets.set(userId, socketId);       
      break;
    }
  }

  private unregisterSocket(userId: string, role: DeliveryUserRole): void {
    switch (role) {
      case "deliverer":   
      this.delivererSockets.delete(userId);   
      break;

      case "transporter": 
      this.transporterSockets.delete(userId); 
      break;

      case "client":      
      this.clientSockets.delete(userId);      
      break;

      case "freelancer":  
      this.freelancerSockets.delete(userId);  
      break;

      case "supervisor":  
      this.supervisorSockets.delete(userId);  
      break;
      
      case "manager":     
      this.managerSockets.delete(userId);     
      break;
      
      case "admin":       
      this.adminSockets.delete(userId);       
      break;
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
      case "deliverer":   
      return this.delivererSockets.get(userId);

      case "transporter": 
      return this.transporterSockets.get(userId);

      case "client":      
      return this.clientSockets.get(userId);

      case "freelancer":  
      return this.freelancerSockets.get(userId);

      case "supervisor":  
      return this.supervisorSockets.get(userId);

      case "manager":     
      return this.managerSockets.get(userId);

      case "admin":       
      return this.adminSockets.get(userId);

      default:            
      return undefined;
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
   * Emit an event to every socket in a route room.
   */
  public emitToRoute(routeId: string, event: string, data: any): void {
    this.io.to(this.getRouteRoom(routeId)).emit(event, data);
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