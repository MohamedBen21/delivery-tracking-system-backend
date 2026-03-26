import { Server } from "socket.io";
import { AuthenticatedSocket } from "../middleware/socketAuth";
import mongoose from "mongoose";

import DelivererModel from "../models/deliverer.model";
import TransporterModel from "../models/transporter.model";
import ClientModel from "../models/client.model";
import PackageModel from "../models/package.model";
import { IUser } from "../models/user.model";



export type DeliveryUserRole = "deliverer" | "transporter" | "client" | "supervisor" | "manager" | "admin";

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
  private delivererSockets: Map<string, string>  = new Map();
  private transporterSockets: Map<string, string> = new Map();
  private clientSockets: Map<string, string>      = new Map();
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
            const isAuthorized =
              role === "admin" ||
              role === "manager" ||
              role === "supervisor" ||
              (role === "client"     && pkg.clientId?.toString() === userId) ||
              (role === "deliverer"  && pkg.assignedDelivererId?.toString()  === userId) ||
              (role === "transporter"&& pkg.assignedTransporterId?.toString() === userId);

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
        // Supervisors join their branch room automatically
        // (branchId expected to be on the socket via middleware or populated separately)
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
  public getConnectionStats(): Record<string, number> {
    return {
      deliverers:   this.delivererSockets.size,
      transporters: this.transporterSockets.size,
      clients:      this.clientSockets.size,
      supervisors:  this.supervisorSockets.size,
      managers:     this.managerSockets.size,
      admins:       this.adminSockets.size,
      total: (
        this.delivererSockets.size +
        this.transporterSockets.size +
        this.clientSockets.size +
        this.supervisorSockets.size +
        this.managerSockets.size +
        this.adminSockets.size
      ),
    };
  }
}