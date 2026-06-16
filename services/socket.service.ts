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
import DeliveryQrSessionModel from "../models/deliveryQrSession.model";
import { IUser } from "../models/user.model";
import sendSMS from "../utils/sendSMS";
import PaymentModel from "../models/payment.model";
import BranchModel from "../models/branch.model";
import VehicleModel from "../models/vehicle.model";

import { PresenceService } from "./presence.service";

// You'll need to install: npm install qrcode
// and: npm install --save-dev @types/qrcode
import QRCode from "qrcode";
import TransportationModel from "../models/transportation.model";

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
  
  // Store delivery QR sessions in memory for quick verification
  private deliveryQRSessions: Map<string, { sessionId: string; code: string; expiresAt: number }> = new Map();

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
  //  CLIENT TRACKING HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private async buildClientTrackingData(pkg: any): Promise<any> {
    let locationData = null;
    
    if (pkg.status === 'at_origin_branch' && pkg.originBranchId) {
      const branch = await BranchModel.findById(pkg.originBranchId)
        .select('name address location phone');
      if (branch) {
        locationData = {
          type: 'branch',
          name: branch.name,
          address: branch.address,
          coordinates: branch.location?.coordinates,
          phone: branch.phone,
          isOrigin: true,
        };
      }
    } else if (pkg.status === 'at_destination_branch' && pkg.destinationBranchId) {
      const branch = await BranchModel.findById(pkg.destinationBranchId)
        .select('name address location phone');
      if (branch) {
        locationData = {
          type: 'branch',
          name: branch.name,
          address: branch.address,
          coordinates: branch.location?.coordinates,
          phone: branch.phone,
          isOrigin: false,
        };
      }
    } else if (pkg.status === 'in_transit_to_branch') {
      const manifest = await ManifestModel.findOne({
        'packages.packageId': pkg._id,
        status: { $in: ['in_transit', 'arrived', 'loaded', 'sealed'] },
      })
        .populate('originBranchId', 'name address location')
        .populate('destinationBranchId', 'name address location')
        .lean();

      if (manifest) {
        const route = await RouteModel.findOne({
          'stops.manifestIds': manifest._id,
          status: { $in: ['active', 'in_transit'] },
        }).lean();

        let currentStopLocation = null;
        if (route && route.currentStopIndex !== undefined) {
          const currentStop = route.stops[route.currentStopIndex];
          if (currentStop?.location?.coordinates) {
            currentStopLocation = currentStop.location.coordinates;
          }
        }

        const destBranch = manifest.destinationBranchId as any;
        
        locationData = {
          type: 'transit',
          manifestCode: manifest.manifestCode,
          originBranch: manifest.originBranchId ? {
            name: (manifest.originBranchId as any)?.name,
            address: (manifest.originBranchId as any)?.address,
          } : null,
          destinationBranch: destBranch ? {
            name: destBranch.name,
            address: destBranch.address,
            coordinates: destBranch.location?.coordinates,
          } : null,
          currentStopLocation,
          estimatedArrival: manifest.estimatedArrival,
        };
      }
    } else if (pkg.status === 'out_for_delivery' && pkg.assignedDelivererId) {
      const deliverer = await DelivererModel.findOne({ userId: pkg.assignedDelivererId })
        .populate('userId', 'name phone')
        .select('currentLocation lastLocationUpdate availabilityStatus');
      
      if (deliverer?.currentLocation?.coordinates) {
        const user = deliverer.userId as any;
        locationData = {
          type: 'deliverer',
          coordinates: deliverer.currentLocation.coordinates,
          lastUpdate: deliverer.lastLocationUpdate || deliverer.lastActiveAt,
          delivererName: user?.name,
          delivererPhone: user?.phone,
          status: deliverer.availabilityStatus,
        };
      }
    } else if (pkg.destination?.location?.coordinates) {
      locationData = {
        type: 'destination',
        coordinates: pkg.destination.location.coordinates,
        address: pkg.destination.address,
        recipientName: pkg.destination.recipientName,
      };
    }

    let estimatedTimeRemaining = null;
    if (pkg.estimatedDeliveryTime && pkg.status !== 'delivered') {
      const remainingMs = new Date(pkg.estimatedDeliveryTime).getTime() - Date.now();
      if (remainingMs > 0) {
        estimatedTimeRemaining = {
          hours: Math.floor(remainingMs / (1000 * 60 * 60)),
          minutes: Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60)),
        };
      }
    }

    return {
      packageId: pkg._id,
      trackingNumber: pkg.trackingNumber,
      status: pkg.status,
      statusDisplay: this.getClientStatusDisplay(pkg.status),
      statusColor: this.getClientStatusColor(pkg.status),
      progress: this.getClientProgress(pkg.status),
      
      currentLocation: locationData,
      
      destination: {
        address: pkg.destination.address,
        city: pkg.destination.city,
        state: pkg.destination.state,
        recipientName: pkg.destination.recipientName,
        recipientPhone: this.maskPhoneNumber(pkg.destination.recipientPhone),
      },
      
      packageInfo: {
        weight: pkg.weight,
        type: pkg.type,
        isFragile: pkg.isFragile,
        description: pkg.description,
      },
      
      timing: {
        estimatedDelivery: pkg.estimatedDeliveryTime,
        estimatedTimeRemaining,
        createdAt: pkg.createdAt,
        deliveredAt: pkg.deliveredAt,
      },
      
      trackingHistory: (pkg.trackingHistory || []).slice(-8).map((event: any) => ({
        status: event.status,
        statusDisplay: this.getClientStatusDisplay(event.status),
        location: event.location,
        notes: event.notes,
        timestamp: event.timestamp,
        isCompleted: true,
      })),
      
      deliveryQr: pkg.deliveryQr ? {
        isActive: pkg.status === 'out_for_delivery' && 
                  !pkg.deliveryQr.verified && 
                  new Date() < pkg.deliveryQr.expiresAt,
        expiresAt: pkg.deliveryQr.expiresAt,
      } : null,
    };
  }

  private getClientStatusDisplay(status: string): string {
    const map: Record<string, string> = {
      pending: 'Order Placed',
      accepted: 'Order Confirmed',
      cashier_claimed: 'Processing',
      at_origin_branch: 'At Pickup Location',
      manifested: 'Preparing for Transit',
      in_transit_to_branch: 'In Transit',
      at_destination_branch: 'At Your Local Branch',
      out_for_delivery: 'Out for Delivery',
      delivered: 'Delivered',
      failed_delivery: 'Delivery Issue',
      failed_delivery_attempt: 'Delivery Attempt Failed',
      cancelled: 'Cancelled',
      returned: 'Returned',
      lost: 'Lost',
      damaged: 'Damaged',
      on_hold: 'On Hold',
      rescheduled: 'Rescheduled',
    };
    return map[status] || status;
  }

  private getClientStatusColor(status: string): string {
    const map: Record<string, string> = {
      pending: '#F59E0B',
      accepted: '#3B82F6',
      cashier_claimed: '#8B5CF6',
      at_origin_branch: '#3B82F6',
      manifested: '#6366F1',
      in_transit_to_branch: '#8B5CF6',
      at_destination_branch: '#F97316',
      out_for_delivery: '#F97316',
      delivered: '#10B981',
      failed_delivery: '#EF4444',
      failed_delivery_attempt: '#EF4444',
      cancelled: '#6B7280',
      returned: '#6B7280',
      lost: '#EF4444',
      damaged: '#EF4444',
      on_hold: '#F59E0B',
      rescheduled: '#F59E0B',
    };
    return map[status] || '#6B7280';
  }

  private getClientProgress(status: string): number {
    const map: Record<string, number> = {
      pending: 5,
      accepted: 10,
      cashier_claimed: 15,
      at_origin_branch: 20,
      manifested: 35,
      in_transit_to_branch: 50,
      at_destination_branch: 75,
      out_for_delivery: 90,
      delivered: 100,
    };
    return map[status] || 0;
  }

  private maskPhoneNumber(phone: string): string {
    if (!phone || phone.length < 8) return phone || 'Not provided';
    return phone.slice(0, 3) + '****' + phone.slice(-3);
  }

  public broadcastPackageStatusToClient(packageId: string, status: string, additionalData?: any) {
    const room = this.getPackageRoom(packageId);
    this.io.to(room).emit('tracking:status_update', {
      packageId,
      status,
      statusDisplay: this.getClientStatusDisplay(status),
      statusColor: this.getClientStatusColor(status),
      progress: this.getClientProgress(status),
      timestamp: new Date(),
      ...additionalData,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GENERATE AND SEND DELIVERY QR
  // ═══════════════════════════════════════════════════════════════════════════

  private async generateAndSendDeliveryQR(
    route: any,
    stopIndex: number,
    routeId: string,
  ): Promise<void> {
    try {
      const stop = route.stops[stopIndex];
      if (!stop || !stop.packageIds[0]) return;
      
      const packageId = stop.packageIds[0].toString();
      const pkg = await PackageModel.findById(packageId)
        .select("destination trackingNumber _id")
        .lean();
      
      if (!pkg) return;
      
      const recipientPhone = (pkg as any).destination?.recipientPhone;
      if (!recipientPhone) {
        console.warn(`[QR] No phone for package ${packageId}`);
        return;
      }

      // Cancel any existing unexpired QR session for this package
      await DeliveryQrSessionModel.updateMany(
        {
          packageId: packageId,
          verified: false,
          expiresAt: { $gt: new Date() },
        },
        { $set: { expiresAt: new Date() } },
      );

      // Generate a unique QR code (cryptographically secure)
      const qrCode = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      // Create the session
      const session = await DeliveryQrSessionModel.create({
        packageId: new mongoose.Types.ObjectId(packageId),
        routeId: new mongoose.Types.ObjectId(routeId),
        stopIndex,
        delivererId: route.assignedDelivererId,
        code: qrCode,
        expiresAt,
        verified: false,
      });

      // Build the payload for the QR code
      const qrPayload = {
        sessionId: session._id.toString(),
        code: qrCode,
        packageId: pkg._id.toString(),
        trackingNumber: pkg.trackingNumber,
        timestamp: Date.now(),
      };

      // Generate QR code as data URL (for storage/display if needed)
      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload));
      
      // Update session with QR image URL
      await DeliveryQrSessionModel.findByIdAndUpdate(session._id, {
        qrImageUrl: qrDataUrl,
      });

      // Update package with QR info
      await PackageModel.findByIdAndUpdate(packageId, {
        $set: {
          "deliveryQr.code": qrCode,
          "deliveryQr.expiresAt": expiresAt,
          "deliveryQr.stopIndex": stopIndex,
          "deliveryQr.routeId": new mongoose.Types.ObjectId(routeId),
          "deliveryQr.generatedAt": new Date(),
          "deliveryQr.verified": false,
          "deliveryQr.sessionId": session._id,
        },
      });

      // Create the frontend URL with the payload in the format: /track?tracking=XXX&payload=XXX
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      const encodedPayload = Buffer.from(JSON.stringify(qrPayload)).toString('base64');
      const deliveryLink = `${frontendUrl}/track?tracking=${pkg.trackingNumber}&payload=${encodedPayload}`;

      // Send SMS with the link
      const smsMessage = `Your package ${pkg.trackingNumber} is out for delivery! 
  Please click the link below to view your QR code for the deliverer:
  ${deliveryLink}

  This link will expire in 30 minutes.`;

      const smsSent = await sendSMS({
        to: recipientPhone,
        message: smsMessage,
      });

      if (!smsSent) {
        console.error(`[QR] SMS failed for package ${packageId}`);
      }

      // Store the session in memory for quick verification
      this.deliveryQRSessions.set(`delivery_qr_${packageId}`, {
        sessionId: session._id.toString(),
        code: qrCode,
        expiresAt: expiresAt.getTime(),
      });

      console.log(`[QR] Generated delivery QR for package ${pkg.trackingNumber}, session: ${session._id}`);
      console.log(`[QR] Link sent to client: ${deliveryLink}`);

    } catch (err) {
      console.error("[Socket] generateAndSendDeliveryQR error:", err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GENERATE AND SEND START-ROUTE QR (to supervisor of origin branch)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  Called when a transporter starts a route. Generates a "start_route" QR
  //  session (stopIndex: -1) and emits it to the supervisor(s) at the route's
  //  origin branch. The supervisor scans this QR (via startRouteByQrCode) to
  //  confirm the transporter is departing with the load.
  //
  private async generateAndSendStartRouteQR(
    route: any,
    routeId: string,
    transporterId: mongoose.Types.ObjectId,
  ): Promise<void> {
    try {
      if (!route.originBranchId) {
        console.warn(`[QR] No originBranchId for route ${routeId}, skipping start_route QR`);
        return;
      }

      const originBranchId = route.originBranchId.toString();

      // Cancel any existing unexpired start_route QR session for this route
      await StopQrSessionModel.updateMany(
        {
          routeId: new mongoose.Types.ObjectId(routeId),
          stopIndex: -1,
          verified: false,
          expiresAt: { $gt: new Date() },
        },
        { $set: { expiresAt: new Date() } },
      );

      const qrCode = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      const totalManifests = route.stops.reduce(
        (sum: number, s: any) => sum + (s.manifestIds?.length ?? 0),
        0,
      );
      const totalPackages = route.stops.reduce(
        (sum: number, s: any) => sum + (s.packageIds?.length ?? 0),
        0,
      );

      const session = await StopQrSessionModel.create({
        routeId: new mongoose.Types.ObjectId(routeId),
        stopIndex: -1,
        stopId: route._id, // no specific stop for start_route; use route id as placeholder
        transporterId,
        branchId: route.originBranchId,
        manifestCount: totalManifests,
        packageCount: totalPackages,
        isLastStop: false,
        code: qrCode,
        expiresAt,
        verified: false,
      });

      const qrPayload = {
        sessionId: session._id.toString(),
        code: qrCode,
        routeId,
        stopIndex: -1,
        type: "start_route",
        timestamp: Date.now(),
      };

      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload));

      this.io
        .to(this.getBranchRoom(originBranchId))
        .emit("supervisor:show_start_route_qr", {
          sessionId: session._id,
          qrCode,
          qrImage: qrDataUrl,
          payload: qrPayload,
          routeId,
          routeNumber: route.routeNumber,
          routeType: route.type,
          transporterId,
          originBranchId,
          totalStops: route.stops.length,
          manifestCount: totalManifests,
          packageCount: totalPackages,
          expiresAt,
          message: `Transporter is departing on route ${route.routeNumber}. Please scan to confirm departure.`,
          timestamp: new Date(),
        });

      console.log(
        `[QR] Generated start_route QR for route ${route.routeNumber}, session: ${session._id}, sent to branch ${originBranchId}`,
      );
    } catch (err) {
      console.error("[Socket] generateAndSendStartRouteQR error:", err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GENERATE AND SEND STOP-VERIFICATION QR (to supervisor of destination branch)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  Called when a transporter requests a QR for a hub stop. Generates a
  //  "stop_verification" QR session for the given stop and emits it to the
  //  supervisor(s) at the stop's destination branch. The supervisor scans this
  //  QR (via arriveAtStopByQrCode) to confirm receipt of the manifests/packages.
  //
  //  Returns the created session so the caller can reuse it instead of
  //  creating a duplicate StopQrSessionModel document.
  //
  private async generateAndSendStopVerificationQR(
    route: any,
    stopIndex: number,
    routeId: string,
    transporterId: mongoose.Types.ObjectId,
  ): Promise<any | null> {
    try {
      const stop = route.stops[stopIndex];
      if (!stop) return null;

      if (!stop.branchId) {
        console.warn(`[QR] No branchId for stop ${stopIndex} on route ${routeId}, skipping stop_verification QR`);
        return null;
      }

      const destinationBranchId = stop.branchId.toString();

      // Cancel any existing unexpired QR session for this stop
      await StopQrSessionModel.updateMany(
        {
          routeId: new mongoose.Types.ObjectId(routeId),
          stopIndex,
          verified: false,
          expiresAt: { $gt: new Date() },
        },
        { $set: { expiresAt: new Date() } },
      );

      const qrCode = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const isLastStop = stopIndex === route.stops.length - 1;

      const manifestCount = stop.manifestIds?.length ?? 0;
      const packageCount = stop.packageIds?.length ?? 0;

      const session = await StopQrSessionModel.create({
        routeId: new mongoose.Types.ObjectId(routeId),
        stopIndex,
        stopId: stop._id,
        transporterId,
        branchId: stop.branchId,
        manifestCount,
        packageCount,
        isLastStop,
        code: qrCode,
        expiresAt,
        verified: false,
      });

      const qrPayload = {
        sessionId: session._id.toString(),
        code: qrCode,
        routeId,
        stopIndex,
        type: "stop_verification",
        timestamp: Date.now(),
      };

      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload));

      this.io
        .to(this.getBranchRoom(destinationBranchId))
        .emit("supervisor:show_stop_qr", {
          sessionId: session._id,
          qrCode,
          qrImage: qrDataUrl,
          payload: qrPayload,
          routeId,
          routeNumber: route.routeNumber,
          routeType: route.type,
          stopIndex,
          stopId: stop._id,
          branchId: stop.branchId,
          transporterId,
          manifestCount,
          packageCount,
          isLastStop,
          expiresAt,
          message: isLastStop
            ? "Transporter has arrived with the final delivery. Please scan to confirm receipt."
            : `Transporter has arrived at stop ${stopIndex + 1}. Please scan to confirm receipt.`,
          timestamp: new Date(),
        });

      console.log(
        `[QR] Generated stop_verification QR for route ${route.routeNumber} stop ${stopIndex}, session: ${session._id}, sent to branch ${destinationBranchId}`,
      );

      return session;
    } catch (err) {
      console.error("[Socket] generateAndSendStopVerificationQR error:", err);
      return null;
    }
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
      //  CLIENT TRACKING EVENTS
      // ══════════════════════════════════════════════════════════════════════

      if (role === "client") {
        
        socket.on("client:track_package", async (data: { 
          trackingNumber: string; 
          clientId?: string;
        }) => {
          try {
            if (!data?.trackingNumber) {
              socket.emit("tracking_error", {
                code: "NO_TRACKING_NUMBER",
                message: "Tracking number is required",
              });
              return;
            }

            const pkg = await PackageModel.findOne({ 
              trackingNumber: data.trackingNumber.toUpperCase() 
            })
              .populate('originBranchId', 'name address location phone')
              .populate('destinationBranchId', 'name address location phone')
              .lean();

            if (!pkg) {
              socket.emit("tracking_error", {
                code: "NOT_FOUND",
                message: "Package not found with this tracking number",
              });
              return;
            }

            const RESTRICTED = ['cancelled', 'lost', 'damaged', 'failed_delivery'];
            if (RESTRICTED.includes(pkg.status)) {
              socket.emit("tracking_error", {
                code: "RESTRICTED",
                message: `This package has been ${pkg.status}. Please contact support.`,
                status: pkg.status,
              });
              return;
            }

            const packageRoom = this.getPackageRoom(pkg._id.toString());
            socket.join(packageRoom);
            
            (socket as any).trackingPackages = (socket as any).trackingPackages || new Set();
            (socket as any).trackingPackages.add(pkg._id.toString());

            const trackingData = await this.buildClientTrackingData(pkg);

            socket.emit("tracking:initial", {
              success: true,
              data: trackingData,
              message: "Tracking started successfully",
            });

            console.log(`[Socket] Client ${userId} started tracking package ${pkg.trackingNumber}`);

          } catch (error: any) {
            console.error('[Socket] client:track_package error:', error);
            socket.emit("tracking_error", {
              code: "TRACKING_FAILED",
              message: error.message || "Failed to track package",
            });
          }
        });

        socket.on("client:untrack_package", async (data: { trackingNumber?: string }) => {
          try {
            if (!data?.trackingNumber) {
              if ((socket as any).trackingPackages) {
                for (const packageId of (socket as any).trackingPackages) {
                  socket.leave(this.getPackageRoom(packageId));
                }
                (socket as any).trackingPackages.clear();
              }
              socket.emit("tracking:stopped", { message: "Stopped tracking all packages" });
              return;
            }

            const pkg = await PackageModel.findOne({ 
              trackingNumber: data.trackingNumber.toUpperCase() 
            }).select('_id').lean();

            if (pkg) {
              socket.leave(this.getPackageRoom(pkg._id.toString()));
              if ((socket as any).trackingPackages) {
                (socket as any).trackingPackages.delete(pkg._id.toString());
              }
              socket.emit("tracking:stopped", { 
                trackingNumber: data.trackingNumber,
                message: "Stopped tracking package",
              });
            }
          } catch (error: any) {
            console.error('[Socket] client:untrack_package error:', error);
            socket.emit("tracking_error", { message: error.message });
          }
        });

        // Client can request to regenerate QR if needed
        socket.on("client:request_delivery_qr", async (data: { trackingNumber: string }) => {
          try {
            if (!data?.trackingNumber) {
              socket.emit("tracking_error", { message: "Tracking number required" });
              return;
            }

            const pkg = await PackageModel.findOne({ 
              trackingNumber: data.trackingNumber.toUpperCase() 
            }).lean();

            if (!pkg) {
              socket.emit("tracking_error", { message: "Package not found" });
              return;
            }

            if (pkg.status !== "out_for_delivery") {
              socket.emit("tracking_error", { 
                message: `Cannot request QR when package status is ${pkg.status}` 
              });
              return;
            }

            if (!pkg.deliveryQr || pkg.deliveryQr.verified) {
              socket.emit("tracking_error", { message: "No active QR available" });
              return;
            }

            if (new Date() > pkg.deliveryQr.expiresAt) {
              socket.emit("tracking_error", { message: "QR has expired" });
              return;
            }

            // Return the QR session info so client can regenerate the QR code
            const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
            const qrPayload = {
              sessionId: pkg.deliveryQr.sessionId,
              code: pkg.deliveryQr.code,
              packageId: pkg._id,
              trackingNumber: pkg.trackingNumber,
              timestamp: pkg.deliveryQr.generatedAt.getTime(),
            };
            const encodedPayload = Buffer.from(JSON.stringify(qrPayload)).toString('base64');
            const qrLink = `${frontendUrl}/track?tracking=${pkg.trackingNumber}&payload=${encodedPayload}`;

            socket.emit("tracking:delivery_qr", {
              packageId: pkg._id,
              trackingNumber: pkg.trackingNumber,
              qrLink,
              expiresAt: pkg.deliveryQr.expiresAt,
              message: "Your delivery QR code link",
            });

            console.log(`[Socket] Client ${userId} requested QR for package ${pkg.trackingNumber}`);

          } catch (error: any) {
            console.error('[Socket] client:request_delivery_qr error:', error);
            socket.emit("tracking_error", { message: error.message });
          }
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      //  TRANSPORTER ROUTE EVENTS
      // ══════════════════════════════════════════════════════════════════════

      if (role === "transporter") {

        // ════════════════════════════════════════════════════════════════════
        //  REQUEST START ROUTE QR
        // ════════════════════════════════════════════════════════════════════
        //
        //  Generates a "start_route" QR session and sends it to the
        //  supervisor(s) at the route's origin branch. The transporter then
        //  asks the supervisor to scan it; the resulting decoded payload is
        //  sent back via start_route to actually begin the route.
        //
        socket.on(
          "request_start_route",
          async (data: { routeId: string }) => {
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
                status: { $in: ["planned", "assigned"] },
              });
              if (!route) {
                socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Route not found, not assigned to you, or already started.",
                });
                return;
              }

              if (!route.originBranchId) {
                socket.emit("route_error", {
                  code: "NO_ORIGIN_BRANCH",
                  message: "This route has no origin branch configured.",
                });
                return;
              }

              await this.generateAndSendStartRouteQR(
                route,
                data.routeId,
                transporter._id,
              );

              socket.emit("start_route_qr_requested", {
                routeId: data.routeId,
                routeNumber: route.routeNumber,
                originBranchId: route.originBranchId,
                message: "QR code sent to the supervisor. Please ask them to scan it to confirm departure.",
                timestamp: new Date(),
              });

              console.log(
                `[Socket] Transporter ${userId} requested start_route QR for route ${data.routeId}`,
              );
            } catch (err: any) {
              socket.emit("route_error", {
                code: "REQUEST_START_ROUTE_FAILED",
                message: err.message || "Failed to request start route QR.",
              });
            }
          },
        );

        socket.on(
          "start_route",
          async (data: {
            sessionId: string;
            qrCode: string;
            routeId: string;
            coordinates: [number, number];
          }) => {
          try {
            // ── Validate inputs ──────────────────────────────────────────
            if (!data?.sessionId || !mongoose.Types.ObjectId.isValid(data.sessionId)) {
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

            // ── Validate QR session ──────────────────────────────────────
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
            if (session.stopIndex !== -1) {
              socket.emit("route_error", {
                code: "NOT_A_START_ROUTE_QR",
                message: "This QR is not a start-route QR.",
              });
              return;
            }

            const route = await RouteModel.findOne({
              _id: data.routeId,
              assignedTransporterId: transporter._id,
              status: { $in: ["planned", "assigned"] },
            });
            if (!route) {
              socket.emit("route_error", {
                code: "ROUTE_NOT_FOUND",
                message: "Route not found, not assigned to you, or already started.",
              });
              return;
            }

            // ── Proximity check (origin branch, 500m) ────────────────────
            if (route.originBranchId) {
              const originBranch = await BranchModel.findById(route.originBranchId)
                .select("location")
                .lean();
              if (originBranch && (originBranch as any).location?.coordinates) {
                const distanceMeters =
                  this.calculateDistance(
                    data.coordinates,
                    (originBranch as any).location.coordinates,
                  ) * 1000;
                if (distanceMeters > 500) {
                  socket.emit("route_error", {
                    code: "TOO_FAR",
                    message: `Must be within 500m of the origin branch to start the route. Current: ${Math.round(distanceMeters)}m.`,
                    distanceMeters: Math.round(distanceMeters),
                    requiredMeters: 500,
                  });
                  return;
                }
              }
            }

            session.verified = true;
            session.verifiedAt = new Date();
            await session.save();

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
              `[Socket] Transporter ${userId} started route ${data.routeId} (${route.type}) via supervisor QR ${session._id}`,
            );
          } catch (err: any) {
            socket.emit("route_error", {
              code: "START_FAILED",
              message: err.message || "Failed to start route.",
            });
          }
        });


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

        socket.on(
          "request_stop_qr",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
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

              const isLastStop = data.stopIndex === route.stops.length - 1;
              const manifestCount = stop.manifestIds?.length ?? 0;
              const packageCount = stop.packageIds?.length ?? 0;

              const session = await this.generateAndSendStopVerificationQR(
                route,
                data.stopIndex,
                data.routeId,
                transporter._id,
              );

              if (!session) {
                socket.emit("route_error", {
                  code: "QR_GENERATION_FAILED",
                  message: "Failed to generate stop verification QR.",
                });
                return;
              }

              const qrCode = session.code;
              const expiresAt = session.expiresAt;

              const pendingPayload = {
                completedManifestIds: data.completedManifestIds ?? [],
                discrepancyManifestIds: data.discrepancyManifestIds ?? [],
                notes: data.notes ?? "",
              };

              if (stop.branchId) {
                this.io
                  .to(this.getBranchRoom(stop.branchId.toString()))
                  .emit("branch:show_stop_qr", {
                    sessionId: session._id,
                    qrCode,
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
                pendingPayload,
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

        socket.on(
          "scan_stop_qr",
          async (data: {
            sessionId: string;
            qrCode: string;
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            completedManifestIds?: string[];
            discrepancyManifestIds?: string[];
            notes?: string;
          }) => {
            try {
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

              session.verified = true;
              session.verifiedAt = new Date();
              await session.save();

              const isLastStop = data.stopIndex === route.stops.length - 1;
              const routeRoom = this.getRouteRoom(data.routeId);

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

              const finalCompletedManifests =
                completedManifestOids.length > 0
                  ? completedManifestOids
                  : ((stop.manifestIds ?? []) as mongoose.Types.ObjectId[]);

              stop.completedManifests = finalCompletedManifests;
              stop.discrepancyManifests = discrepancyManifestOids;

              await route.completeStop(data.stopIndex, [], [], data.notes);

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

              if (isLastStop) {
                await route.completeRoute(data.notes);

                if (route.type === "hub_to_hub" && stop.branchId) {
                  await TransporterModel.findByIdAndUpdate(transporter._id, {
                    availabilityStatus: "available",
                    currentRouteId: null,
                    currentBranchId: stop.branchId,
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

        socket.on(
          "complete_delivery",
          async (data: {
            sessionId: string;
            qrCode: string;
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            notes?: string;
          }) => {
            try {
              // ── Validate inputs ──────────────────────────────────────────
              if (!data?.sessionId || !mongoose.Types.ObjectId.isValid(data.sessionId)) {
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
              if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
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

              // ── Fetch deliverer ──────────────────────────────────────────
              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                return;
              }

              // ── Validate QR session ──────────────────────────────────────
              const session = await DeliveryQrSessionModel.findById(data.sessionId);
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
                  message: "QR code has expired. Please request a new one from the client.",
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

              if (session.delivererId.toString() !== deliverer._id.toString()) {
                socket.emit("route_error", {
                  code: "WRONG_DELIVERER",
                  message: "This QR code belongs to a different deliverer.",
                });
                return;
              }

              // ── Fetch and validate route ─────────────────────────────────
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
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
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

              if (session.packageId.toString() !== stop.packageIds[0].toString()) {
                socket.emit("route_error", {
                  code: "PACKAGE_MISMATCH",
                  message: "QR code is for a different package.",
                });
                return;
              }

              // ── Proximity check (commented out) ──────────────────────────
              // const distanceMeters =
              //   this.calculateDistance(
              //     data.coordinates,
              //     stop.location.coordinates,
              //   ) * 1000;
              // if (distanceMeters > 50) {
              //   socket.emit("route_error", {
              //     code: "TOO_FAR",
              //     message: `Must be within 50m to complete delivery. Current: ${Math.round(distanceMeters)}m.`,
              //     distanceMeters: Math.round(distanceMeters),
              //     requiredMeters: 50,
              //   });
              //   return;
              // }

              // ── Mark QR as verified ──────────────────────────────────────
              session.verified = true;
              session.verifiedAt = new Date();
              await session.save();

              const packageId = stop.packageIds[0].toString();
              const pkg = await PackageModel.findById(packageId);
              if (!pkg) {
                socket.emit("route_error", {
                  code: "PACKAGE_NOT_FOUND",
                  message: "Package not found.",
                });
                return;
              }

              // Update package with verification
              await PackageModel.findByIdAndUpdate(packageId, {
                $set: {
                  "deliveryQr.verified": true,
                  "deliveryQr.verifiedAt": new Date(),
                },
              });

              // ── Mark package as delivered ────────────────────────────────
              await pkg.markAsDelivered(deliverer.userId, data.notes);
              
              // Update payment
              await PaymentModel.findOneAndUpdate(
                { packageId },
                {
                  $set: { status: "collected", delivererId: deliverer.userId },
                },
              );

              // Remove from memory
              this.deliveryQRSessions.delete(`delivery_qr_${packageId}`);

              // Broadcast to client
              this.broadcastPackageStatusToClient(packageId, "delivered", {
                deliveredAt: new Date(),
              });

              this.io
                .to(this.getPackageRoom(packageId))
                .emit("package_delivered", {
                  packageId,
                  deliveredAt: new Date(),
                  message: "Your package has been delivered!",
                  timestamp: new Date(),
                });

              // Update deliverer stats
              const delivererDoc = await DelivererModel.findById(deliverer._id);
              if (delivererDoc) {
                const isCOD = pkg.paymentMethod === "cod";
                await delivererDoc.recordDeliveryPayment(pkg.totalPrice, isCOD);
                delivererDoc.totalDeliveries += 1;
                delivererDoc.successfulDeliveries += 1;
                delivererDoc.lastActiveAt = new Date();
                await delivererDoc.save();
              }

              // ── Complete the stop in route (similar to complete_stop) ────
              const isLastStop = data.stopIndex === route.stops.length - 1;
              const routeRoom = this.getRouteRoom(data.routeId);

              await route.completeStop(
                data.stopIndex,
                [new mongoose.Types.ObjectId(packageId)],
                [],
                data.notes,
              );

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
                  currentStopIndex: route.currentStopIndex,
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

                this.io.to(routeRoom).emit("delivery_route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Deliverer ${userId} COMPLETED delivery route ${data.routeId} via QR`,
                );
              } else {
                const nextStop = route.stops[data.stopIndex + 1];
                socket.emit("delivery_stop_completed", {
                  routeId: data.routeId,
                  completedStopIndex: data.stopIndex,
                  completedStopId: stop._id,
                  packageId,
                  nextStop: nextStop
                    ? {
                        stopIndex: data.stopIndex + 1,
                        stopId: nextStop._id,
                        clientId: nextStop.clientId,
                        packageId: nextStop.packageIds[0],
                        address: nextStop.address,
                        location: nextStop.location.coordinates,
                        status: nextStop.status,
                      }
                    : null,
                  remainingStops: route.stops.length - (data.stopIndex + 1),
                  timestamp: new Date(),
                });

                if (stop.clientId) {
                  this.io
                    .to(this.getBranchRoom(deliverer.branchId.toString()))
                    .emit("deliverer_left_client", {
                      routeId: data.routeId,
                      delivererId: deliverer._id,
                      stopIndex: data.stopIndex,
                      packageId,
                      timestamp: new Date(),
                    });
                }

                this.io.to(routeRoom).emit("delivery_stop_completed", {
                  routeId: data.routeId,
                  stopIndex: data.stopIndex,
                  packageId,
                  nextStopIndex: data.stopIndex + 1,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Deliverer ${userId} completed delivery stop ${data.stopIndex}/${route.stops.length - 1} via QR`,
                );
              }
            } catch (err: any) {
              console.error("[Socket] complete_delivery failed:", err);
              socket.emit("route_error", {
                code: "COMPLETE_DELIVERY_FAILED",
                message: err.message || "Failed to complete delivery.",
              });
            }
          },
        );

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
      }

      // ══════════════════════════════════════════════════════════════════════
      //  DELIVERER ROUTE EVENTS
      // ══════════════════════════════════════════════════════════════════════

      if (role === "deliverer") {

        socket.on("start_delivery_route",
          async (data: { routeId: string; packageId?: string }) => {
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
            });
            if (!route) {
              socket.emit("route_error", {
                code: "ROUTE_NOT_FOUND",
                message: "Route not found or not assigned to you.",
              });
              return;
            }

            const firstStop = route.stops[0];
            if (!firstStop || !firstStop.packageIds[0]) {
              socket.emit("route_error", {
                code: "NO_PACKAGES",
                message: "No packages found in this route.",
              });
              return;
            }

            const expectedPackageId = firstStop.packageIds[0].toString();

            if (data.packageId && data.packageId !== expectedPackageId) {
              socket.emit("route_error", {
                code: "PACKAGE_MISMATCH",
                message: `Package mismatch. Expected package ${expectedPackageId} but received ${data.packageId}.`,
                expectedPackageId,
                receivedPackageId: data.packageId,
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

            firstStop.status = "in_progress";
            await route.save();

            const firstPackageId = firstStop.packageIds[0].toString();
            const firstPackage = await PackageModel.findById(firstPackageId);
            if (firstPackage) {
              await firstPackage.updateStatus(
                "out_for_delivery",
                new mongoose.Types.ObjectId(userId),
                deliverer.branchId,
                "Package picked up by deliverer - out for delivery",
                firstStop.address
              );
              
              this.broadcastPackageStatusToClient(firstPackageId, "out_for_delivery");
            }

            await this.generateAndSendDeliveryQR(route, 0, data.routeId);

            socket.emit("delivery_route_started", {
              routeId: data.routeId,
              routeNumber: route.routeNumber,
              status: "active",
              stopIndex: 0,
              totalStops: route.stops.length,
              currentStop: {
                stopId: firstStop._id,
                clientId: firstStop.clientId,
                packageId: firstPackageId,
                address: firstStop.address,
                location: firstStop.location.coordinates,
                recipientName: (firstStop as any).recipientName,
                recipientPhone: (firstStop as any).recipientPhone,
                qrSent: true,
                status: "in_progress",
              },
              scheduledEnd: route.scheduledEnd,
              message: "Route started! QR code sent to client for first package.",
              timestamp: new Date(),
            });

            this.io
              .to(this.getBranchRoom(deliverer.branchId.toString()))
              .emit("deliverer_route_started", {
                routeId: data.routeId,
                routeNumber: route.routeNumber,
                stopIndex:route.currentStopIndex,
                delivererId: deliverer._id,
                userId,
                totalStops: route.stops.length,
                actualStart: route.actualStart,
                scheduledEnd: route.scheduledEnd,
                timestamp: new Date(),
              });

            console.log(
              `[Socket] Deliverer ${userId} started delivery route ${data.routeId} and auto-started first package`,
            );
          } catch (err: any) {
            socket.emit("route_error", {
              code: "START_FAILED",
              message: err.message || "Failed to start route.",
            });
          }
        });

        socket.on("start_package", async (data: {
          routeId: string;
          stopIndex: number;
          packageId?: string;
        }) => {
          try {
            if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
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

            let targetStopIndex = data.stopIndex;
            if (data.packageId) {
              const matchingStopIndex = route.stops.findIndex(
                (s) =>
                  (s.status === "pending" || s.status === "in_progress") &&
                  s.packageIds.some((pid) => pid.toString() === data.packageId)
              );
              if (matchingStopIndex !== -1) {
                targetStopIndex = matchingStopIndex;
              }
            }

            if (targetStopIndex !== route.currentStopIndex) {
              const targetStop = route.stops[targetStopIndex];
              if (targetStop && targetStop.status === "pending") {
                route.currentStopIndex = targetStopIndex;
                await route.save();
              } else {
                socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}, got ${targetStopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                return;
              }
            }

            const stop = route.stops[targetStopIndex];
            if (!stop || !stop.packageIds[0]) {
              socket.emit("route_error", {
                code: "STOP_NOT_FOUND",
                message: "Stop or package not found.",
              });
              return;
            }

            const expectedPackageId = stop.packageIds[0].toString();

            if (!data.packageId) {
              socket.emit("route_error", {
                code: "PACKAGE_ID_REQUIRED",
                message: "packageId is required to start a package.",
                expectedPackageId,
              });
              return;
            }

            if (data.packageId !== expectedPackageId) {
              socket.emit("route_error", {
                code: "PACKAGE_MISMATCH",
                message: `Package mismatch. Expected package ${expectedPackageId} but received ${data.packageId}.`,
                expectedPackageId,
                receivedPackageId: data.packageId,
              });
              return;
            }

            const packageId = stop.packageIds[0].toString();

            if (stop.status === "in_progress") {
              socket.emit("route_error", {
                code: "PACKAGE_ALREADY_STARTED",
                message: "This package has already been started.",
                packageId,
              });
              return;
            }

            stop.status = "in_progress";
            await route.save();

            const pkg = await PackageModel.findById(packageId);
            if (pkg) {
              await pkg.updateStatus(
                "out_for_delivery",
                new mongoose.Types.ObjectId(userId),
                deliverer.branchId,
                "Package started by deliverer - out for delivery",
                stop.address
              );
              
              this.broadcastPackageStatusToClient(packageId, "out_for_delivery");
            }

            await this.generateAndSendDeliveryQR(route, targetStopIndex, data.routeId);

            socket.emit("package_started", {
              routeId: data.routeId,
              stopId: stop._id,
              packageId,
              address: stop.address,
              location: stop.location.coordinates,
              recipientName: (stop as any).recipientName,
              recipientPhone: (stop as any).recipientPhone,
              stopIndex: route.currentStopIndex,
              message: "Package started. QR code sent to client. Ask client to show the QR code for verification.",
              qrSent: true,
              timestamp: new Date(),
            });

            console.log(`[Socket] Deliverer ${userId} started package ${packageId} at stop ${targetStopIndex}`);
          } catch (err: any) {
            socket.emit("route_error", {
              code: "START_PACKAGE_FAILED",
              message: err.message || "Failed to start package.",
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
                    message: "Your deliverer has arrived! Please show your QR code.",
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
                message: "Arrival confirmed. Ask the client to show their QR code.",
                currentStopIndex: route.currentStopIndex,
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

        // NEW: Verify delivery QR code (replaces complete_delivery with OTP)
        socket.on(
          "complete_delivery",
          async (data: {
            sessionId: string;
            qrCode: string;
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            notes?: string;
          }) => {
            try {
              // ── Validate inputs ──────────────────────────────────────────
              if (!data?.sessionId || !mongoose.Types.ObjectId.isValid(data.sessionId)) {
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
              if (!data?.routeId || !mongoose.Types.ObjectId.isValid(data.routeId)) {
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

              // ── Fetch deliverer ──────────────────────────────────────────
              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) {
                socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                return;
              }

              // ── Validate QR session ──────────────────────────────────────
              const session = await DeliveryQrSessionModel.findById(data.sessionId);
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
                  message: "QR code has expired. Please request a new one from the client.",
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

              if (session.delivererId.toString() !== deliverer._id.toString()) {
                socket.emit("route_error", {
                  code: "WRONG_DELIVERER",
                  message: "This QR code belongs to a different deliverer.",
                });
                return;
              }

              // ── Fetch and validate route ─────────────────────────────────
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
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
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

              if (session.packageId.toString() !== stop.packageIds[0].toString()) {
                socket.emit("route_error", {
                  code: "PACKAGE_MISMATCH",
                  message: "QR code is for a different package.",
                });
                return;
              }

              // ── Proximity check (50m) ────────────────────────────────────
              // const distanceMeters =
              //   this.calculateDistance(
              //     data.coordinates,
              //     stop.location.coordinates,
              //   ) * 1000;
              // if (distanceMeters > 50) {
              //   socket.emit("route_error", {
              //     code: "TOO_FAR",
              //     message: `Must be within 50m to complete delivery. Current: ${Math.round(distanceMeters)}m.`,
              //     distanceMeters: Math.round(distanceMeters),
              //     requiredMeters: 50,
              //   });
              //   return;
              // }

              // ── Mark QR as verified ──────────────────────────────────────
              session.verified = true;
              session.verifiedAt = new Date();
              await session.save();

              const packageId = stop.packageIds[0].toString();
              const pkg = await PackageModel.findById(packageId);
              if (!pkg) {
                socket.emit("route_error", {
                  code: "PACKAGE_NOT_FOUND",
                  message: "Package not found.",
                });
                return;
              }

              // Update package with verification
              await PackageModel.findByIdAndUpdate(packageId, {
                $set: {
                  "deliveryQr.verified": true,
                  "deliveryQr.verifiedAt": new Date(),
                },
              });

              // ── Complete delivery ────────────────────────────────────────
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

              // Remove from memory
              this.deliveryQRSessions.delete(`delivery_qr_${packageId}`);

              // Broadcast to client
              this.broadcastPackageStatusToClient(packageId, "delivered", {
                deliveredAt: new Date(),
              });

              this.io
                .to(this.getPackageRoom(packageId))
                .emit("package_delivered", {
                  packageId,
                  deliveredAt: new Date(),
                  message: "Your package has been delivered!",
                  timestamp: new Date(),
                });

              // Update deliverer stats
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
                  currentStopIndex: route.currentStopIndex,
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

                this.io.to(routeRoom).emit("delivery_route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Deliverer ${userId} COMPLETED delivery route ${data.routeId} via QR`,
                );
              } else {
                const nextStop = route.stops[data.stopIndex + 1];
                
                if (nextStop && nextStop.packageIds[0]) {
                  nextStop.status = "in_progress";
                  await route.save();

                  const nextPackageId = nextStop.packageIds[0].toString();
                  const nextPackage = await PackageModel.findById(nextPackageId);
                  if (nextPackage) {
                    await nextPackage.updateStatus(
                      "out_for_delivery",
                      new mongoose.Types.ObjectId(userId),
                      deliverer.branchId,
                      "Next package auto-started after delivery",
                      nextStop.address
                    );
                    
                    this.broadcastPackageStatusToClient(nextPackageId, "out_for_delivery");
                  }

                  await this.generateAndSendDeliveryQR(
                    route,
                    data.stopIndex + 1,
                    data.routeId,
                  );

                  socket.emit("delivery_stop_completed", {
                    routeId: data.routeId,
                    completedStopIndex: data.stopIndex,
                    packageId,
                    // distanceMeters: Math.round(distanceMeters),
                    nextStop: {
                      stopIndex: data.stopIndex + 1,
                      stopId: nextStop._id,
                      clientId: nextStop.clientId,
                      packageId: nextPackageId,
                      address: nextStop.address,
                      location: nextStop.location.coordinates,
                      qrSent: true,
                      status: nextStop.status,
                    },
                    remainingStops: route.stops.length - (data.stopIndex + 1),
                    currentStopIndex: route.currentStopIndex,
                    message: `Package delivered! Next package QR sent to client.`,
                    timestamp: new Date(),
                  });
                } else {
                  socket.emit("delivery_stop_completed", {
                    routeId: data.routeId,
                    completedStopIndex: data.stopIndex,
                    packageId,
                    // distanceMeters: Math.round(distanceMeters),
                    remainingStops: route.stops.length - (data.stopIndex + 1),
                    currentStopIndex: route.currentStopIndex,
                    message: `Package delivered! ${route.stops.length - (data.stopIndex + 1)} stops remaining.`,
                    timestamp: new Date(),
                  });
                }
                this.io.to(routeRoom).emit("delivery_stop_completed", {
                  routeId: data.routeId,
                  stopIndex: data.stopIndex,
                  packageId,
                  timestamp: new Date(),
                });
                console.log(
                  `[Socket] Deliverer ${userId} completed delivery stop ${data.stopIndex} via QR`,
                );
              }
            } catch (err: any) {
              console.error("[Socket] verify_delivery_qr failed:", err);
              socket.emit("route_error", {
                code: "VERIFY_QR_FAILED",
                message: err.message || "Failed to verify delivery QR.",
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
              // if (distanceMeters > 50) {
              //   socket.emit("route_error", {
              //     code: "TOO_FAR",
              //     message: `Must be within 50m. Current: ${Math.round(distanceMeters)}m.`,
              //     distanceMeters: Math.round(distanceMeters),
              //     requiredMeters: 50,
              //   });
              //   return;
              // }

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
              
              this.broadcastPackageStatusToClient(packageId, "failed_delivery_attempt", {
                reason: data.reason,
              });

              // Invalidate the QR session
              if (pkg.deliveryQr?.sessionId) {
                await DeliveryQrSessionModel.findByIdAndUpdate(pkg.deliveryQr.sessionId, {
                  $set: { expiresAt: new Date() },
                });
                this.deliveryQRSessions.delete(`delivery_qr_${packageId}`);
              }

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
                    currentStopIndex: route.currentStopIndex,
                    message:
                      "Route finished. Please return the failed package to your branch.",
                    timestamp: new Date(),
                  });
                } else {
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
                          qrSent: false,
                          status: nextStop.status === "in_progress" ? "in_progress" : "pending",
                        }
                      : null,
                    remainingStops: totalStopsNow - route.currentStopIndex,
                    currentStopIndex: route.currentStopIndex,
                    message: "Maximum attempts reached. Package will be returned. Continuing to next stop.",
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
                        qrSent: false,
                        status: nextStop.status === "in_progress" ? "in_progress" : "pending",
                      }
                    : null,
                  remainingStops: totalStopsNow - route.currentStopIndex,
                  currentStopIndex: route.currentStopIndex,
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
          "cancel_package",
          async (data: {
            routeId: string;
            stopIndex: number;
            coordinates: [number, number];
            currentPage: string;
            reason: string;
            notes?: string;
          }) => {
            console.log(`[Socket] Deliverer ${userId} requested package cancellation at stop ${data.stopIndex} of route ${data.routeId}`);
            try {
              if (!data?.routeId || !data?.reason) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                    code: "MISSING_DATA",
                    message: "routeId and reason are required.",
                  });
                }else {
                  socket.emit("route_error", {
                    code: "MISSING_DATA",
                    message: "routeId and reason are required.",
                  });
                }
                return;
              }
              if (
                !data?.routeId ||
                !mongoose.Types.ObjectId.isValid(data.routeId)
              ) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                }else{
                  socket.emit("route_error", {
                  code: "INVALID_ROUTE_ID",
                  message: "Invalid routeId.",
                });
                }
                return;
              }
              if (data.stopIndex === undefined || data.stopIndex < 0) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                  code: "INVALID_STOP",
                  message: "Invalid stopIndex.",
                });
                }else {
                  socket.emit("route_error", {
                  code: "INVALID_STOP",
                  message: "Invalid stopIndex.",
                });
                }
                return;
              }

              const deliverer = await DelivererModel.findOne({ userId }).lean();
              if (!deliverer) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                }else {
                  socket.emit("route_error", {
                  code: "NOT_FOUND",
                  message: "Deliverer not found.",
                });
                }
                return;
              }

              const route = await RouteModel.findOne({
                _id: data.routeId,
                assignedDelivererId: deliverer._id,
                status: "active",
              });
              if (!route) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                }else {
                  socket.emit("route_error", {
                  code: "ROUTE_NOT_FOUND",
                  message: "Active route not found.",
                });
                }
                return;
              }

              if (data.stopIndex !== route.currentStopIndex) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                }else {
                  socket.emit("route_error", {
                  code: "WRONG_STOP",
                  message: `Expected stop ${route.currentStopIndex}, got ${data.stopIndex}.`,
                  expectedStopIndex: route.currentStopIndex,
                });
                }
                return;
              }

              const stop = route.stops[data.stopIndex];
              if (!stop || !stop.packageIds[0]) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop or package not found.",
                });
                }else {
                  socket.emit("route_error", {
                  code: "STOP_NOT_FOUND",
                  message: "Stop or package not found.",
                });
                }
                return;
              }

              const packageId = stop.packageIds[0].toString();

              const pkg = await PackageModel.findById(packageId);
              if (!pkg) {
                if(data.currentPage === "home") {
                  socket.emit("route_error_home", {
                  code: "PACKAGE_NOT_FOUND",
                  message: "Package not found.",
                });
                }else {
                  socket.emit("route_error", {
                  code: "PACKAGE_NOT_FOUND",
                  message: "Package not found.",
                });
                }
                return;
              }

              // Invalidate QR session
              if (pkg.deliveryQr?.sessionId) {
                await DeliveryQrSessionModel.findByIdAndUpdate(pkg.deliveryQr.sessionId, {
                  $set: { expiresAt: new Date() },
                });
                this.deliveryQRSessions.delete(`delivery_qr_${packageId}`);
              }

              const cancellationDetails = {
                cancelledBy: deliverer.userId,
                cancelledAt: new Date().toISOString(),
                routeId: data.routeId,
                routeNumber: route.routeNumber,
                stopIndex: data.stopIndex,
                stopId: stop._id?.toString(),
                coordinates: data.coordinates,
                reason: data.reason,
                additionalNotes: data.notes || "",
              };

              const trackingNotes = JSON.stringify(cancellationDetails);

              await pkg.updateStatus(
                "cancelled",
                deliverer.userId,
                pkg.currentBranchId || deliverer.branchId,
                `Cancelled by deliverer at stop ${data.stopIndex + 1} of route ${route.routeNumber}. Details: ${trackingNotes}`,
                stop.address
              );

              this.broadcastPackageStatusToClient(packageId, "cancelled", {
                reason: data.reason,
              });

              await PaymentModel.findOneAndUpdate(
                { packageId: pkg._id },
                {
                  $set: {
                    status: "cancelled",
                  },
                },
              );

              await route.failStop(data.stopIndex, data.reason, [
                new mongoose.Types.ObjectId(packageId),
              ]);

              await DelivererModel.findByIdAndUpdate(deliverer._id, {
                $inc: { totalDeliveries: 1, failedDeliveries: 1 },
                lastActiveAt: new Date(),
              });

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

              const updatedPkg = await PackageModel.findById(packageId).lean();
              const isLastStop = data.stopIndex === route.stops.length - 1;
              const routeRoom = this.getRouteRoom(data.routeId);

              if(data.currentPage === "home") {
                socket.emit("cancellation_success_home", {
                success: true,
                routeId: data.routeId,
                packageId,
                trackingNumber: updatedPkg?.trackingNumber,
                stopId: stop._id,
                branchId: stop.branchId,
                address: stop.address,
                reason: data.reason,
                notes: data.notes,
                stopIndex: route.currentStopIndex,
                isLastStop,
                message: `Package ${updatedPkg?.trackingNumber || packageId} has been successfully cancelled.`,
                timestamp: new Date(),
              });
              }else{
                console.log(route.currentStopIndex,)
                socket.emit("cancellation_success", {
                success: true,
                routeId: data.routeId,
                packageId,
                trackingNumber: updatedPkg?.trackingNumber,
                stopId: stop._id,
                branchId: stop.branchId,
                address: stop.address,
                reason: data.reason,
                notes: data.notes,
                stopIndex: route.currentStopIndex,
                isLastStop,
                message: `Package ${updatedPkg?.trackingNumber || packageId} has been successfully cancelled.`,
                timestamp: new Date(),
              });
              }

              this.io
                .to(this.getPackageRoom(packageId))
                .emit("package_cancelled", {
                  packageId,
                  trackingNumber: updatedPkg?.trackingNumber,
                  cancelledBy: deliverer.userId,
                  cancellationDetails: {
                    routeId: data.routeId,
                    routeNumber: route.routeNumber,
                    stopIndex: data.stopIndex,
                    coordinates: data.coordinates,
                    reason: data.reason,
                    notes: data.notes,
                  },
                  message: "This package has been permanently cancelled by the deliverer.",
                  timestamp: new Date(),
                });

              this.io
                .to(this.getPackageRoom(packageId))
                .emit("package_status_update", {
                  packageId,
                  status: "cancelled",
                  trackingNumber: updatedPkg?.trackingNumber,
                  message: "Package cancelled by deliverer",
                  timestamp: new Date(),
                });

              this.io
                .to(this.getBranchRoom(deliverer.branchId.toString()))
                .emit("deliverer_package_cancelled", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  delivererId: deliverer._id,
                  userId,
                  stopIndex: data.stopIndex,
                  stopId: stop._id,
                  packageId,
                  trackingNumber: updatedPkg?.trackingNumber,
                  cancellationDetails: {
                    routeId: data.routeId,
                    stopIndex: data.stopIndex,
                    coordinates: data.coordinates,
                    reason: data.reason,
                    notes: data.notes,
                  },
                  message: `Package ${updatedPkg?.trackingNumber} has been permanently cancelled.`,
                  timestamp: new Date(),
                });

              if (isLastStop) {
                await route.completeRoute(
                  `Last stop cancelled: ${data.reason}${data.notes ? ` - ${data.notes}` : ""}`,
                );
                
                await DelivererModel.findByIdAndUpdate(deliverer._id, {
                  availabilityStatus: "available",
                  currentRouteId: null,
                  lastActiveAt: new Date(),
                });

                socket.emit("delivery_route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  status: "completed",
                  totalStops: route.stops.length,
                  completedStops: route.completedStops,
                  failedStops: route.failedStops,
                  actualStart: route.actualStart,
                  actualEnd: route.actualEnd,
                  actualTime: route.actualTime,
                  onTimePerformance: route.onTimePerformance,
                  hasCancelledPackage: true,
                  currentStopIndex: route.currentStopIndex,
                  message: "Route completed. Package was permanently cancelled.",
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
                    hasCancelledPackage: true,
                    timestamp: new Date(),
                  });

                this.io.to(routeRoom).emit("delivery_route_completed", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Deliverer ${userId} cancelled package ${packageId} ` +
                  `and COMPLETED route ${data.routeId}`,
                );
              } else {
                socket.emit("package_cancelled", {
                  routeId: data.routeId,
                  routeNumber: route.routeNumber,
                  cancelledStopIndex: data.stopIndex,
                  cancelledStopId: stop._id,
                  packageId,
                  trackingNumber: updatedPkg?.trackingNumber,
                  cancellationDetails: {
                    routeId: data.routeId,
                    stopIndex: data.stopIndex,
                    coordinates: data.coordinates,
                    reason: data.reason,
                    notes: data.notes,
                  },
                  nextStop: null,
                  remainingStops: route.stops.length - (data.stopIndex + 1),
                  currentStopIndex: route.currentStopIndex,
                  message: `Package permanently cancelled. ${route.stops.length - (data.stopIndex + 1)} stops remaining. Next package needs to be started manually.`,
                  timestamp: new Date(),
                });

                this.io.to(routeRoom).emit("delivery_stop_cancelled", {
                  routeId: data.routeId,
                  stopIndex: data.stopIndex,
                  stopId: stop._id,
                  packageId,
                  reason: data.reason,
                  timestamp: new Date(),
                });

                console.log(
                  `[Socket] Deliverer ${userId} cancelled package ${packageId} ` +
                  `at stop ${data.stopIndex}/${route.stops.length - 1} - next package not auto-started`,
                );
              }
            } catch (err: any) {
              console.error("[Socket] cancel_package failed:", err);
              socket.emit("route_error", {
                code: "CANCEL_PACKAGE_FAILED",
                message: err.message || "Failed to cancel package.",
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
              const BranchModelModule = await import("../models/branch.model");
              const branch = await BranchModelModule.default.findById(data.branchId)
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
              
              this.broadcastPackageStatusToClient(data.packageId, "returned");
              
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
      }

      // ══════════════════════════════════════════════════════════════════════
      //  PACKAGE / MANIFEST TRACKING (keep existing)
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
      //  BRANCH ROOM MANAGEMENT
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
  //  PRIVATE HELPERS (keep existing)
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
        
        this.io
          .to(this.getPackageRoom(pkg._id.toString()))
          .emit("tracking:location_update", {
            type: "deliverer",
            coordinates,
            lastUpdate: new Date(),
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
        
        const manifest = await ManifestModel.findOne({
          'packages.packageId': pkg._id,
          status: 'in_transit',
        }).select('estimatedArrival destinationBranchId').lean();
        
        this.io
          .to(this.getPackageRoom(pkg._id.toString()))
          .emit("tracking:location_update", {
            type: "transit",
            coordinates,
            lastUpdate: new Date(),
            estimatedArrival: manifest?.estimatedArrival,
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
      console.error(
        `[Socket] resumeActiveSession failed for ${role} ${userId}:`,
        err.message,
      );
    }
  }

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

    const stop = route.stops[route.currentStopIndex];
    if (!stop) return;

    const activePackageId = stop.packageIds[0] ?? null;
    if (!activePackageId) return;

    const pkg = await PackageModel.findById(activePackageId)
      .select(
        "trackingNumber status destination attemptCount maxAttempts totalPrice paymentStatus estimatedDeliveryTime deliveryQr",
      )
      .lean();

    // Check if QR is still active
    const qrActive = pkg?.deliveryQr && 
                     pkg.status === "out_for_delivery" &&
                     !pkg.deliveryQr.verified &&
                     new Date() < pkg.deliveryQr.expiresAt;

    socket.join(this.getRouteRoom(route._id.toString()));

    const isPackageStarted = stop.status === "in_progress";

    if (isPackageStarted) {
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
        packageStarted: true,

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
              totalPrice: pkg.totalPrice,
              paymentStatus: pkg.paymentStatus,
              address: pkg.destination?.address,
              city: pkg.destination?.city,
              attemptCount: pkg.attemptCount,
              maxAttempts: pkg.maxAttempts,
              estimatedDeliveryTime: pkg.estimatedDeliveryTime,
              qr: {
                active: qrActive,
                expiresAt: pkg.deliveryQr?.expiresAt ?? null,
                verified: pkg.deliveryQr?.verified ?? false,
              },
            }
          : null,

        message:
          route.status === "paused"
            ? "Your route was paused. Tap Resume to continue."
            : "You have an active delivery. Ask client to show QR code.",
        timestamp: new Date(),
      });
    }/*  else {
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
        packageStarted: false,
        packageNotStarted: true,

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
            }
          : null,

        message:
          route.status === "paused"
            ? "Your route was paused. Tap Resume to continue, then start the package."
            : "You have an active route. Tap 'Start Package' to begin delivery.",
        timestamp: new Date(),
      });
    } */

    console.log(
      `[Socket] Deliverer ${userId} resumed — route ${route.routeNumber} ` +
        `stop ${route.currentStopIndex}/${route.stops.length - 1} ` +
        `pkg ${activePackageId} started=${isPackageStarted} qrActive=${qrActive}`,
    );
  }

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

    // ── Find or create transportation for this route ──────────────────────────
    let transportation: any = await TransportationModel.findOne({
      sourceRouteId: route._id,
    }).lean();

    // If no transportation exists, create one (shouldn't happen if route is active)
    if (!transportation) {
      // Flatten manifestIds across all stops
      const manifestIds = route.stops.reduce<mongoose.Types.ObjectId[]>(
        (acc, stop) => acc.concat(stop.manifestIds || []),
        [],
      );

      let totalWeight = 0;
      let totalPackages = 0;
      if (manifestIds.length > 0) {
        const manifests = await ManifestModel.find({ _id: { $in: manifestIds } })
          .select("totalDeclaredWeight packageCount")
          .lean();
        for (const m of manifests) {
          totalWeight += m.totalDeclaredWeight || 0;
          totalPackages += m.packageCount || 0;
        }
      }

      const firstStop = route.stops[0];
      const lastStop = route.stops[route.stops.length - 1];

      const sourcePoint = {
        branchId: route.originBranchId,
        location: firstStop?.location,
      };
      const destinationPoint = {
        branchId: route.destinationBranchId ?? lastStop?.branchId,
        location: lastStop?.location,
      };

      const created = await TransportationModel.create({
        companyId: route.companyId,
        sourceRouteId: route._id,
        source: sourcePoint,
        destination: destinationPoint,
        manifestIds,
        manifestCount: manifestIds.length,
        packageCount: totalPackages,
        totalWeight,
        totalVolume: 0,
        assignedTransporterId: route.assignedTransporterId,
        assignedVehicleId: route.assignedVehicleId,
        status: route.status === 'active' ? 'in_transit' : 'pending',
        estimatedDeliveryTime: route.scheduledEnd,
        actualDeliveryTime: route.actualEnd,
        departedAt: route.actualStart,
      });
      transportation = created.toObject();
    } else {
      // ── Sync transportation status with route status ────────────────────────
      let shouldUpdate = false;
      let newStatus = transportation.status;

      // Map route status to transportation status
      if (route.status === 'completed' && transportation.status !== 'completed') {
        newStatus = 'completed';
        shouldUpdate = true;
      } else if (route.status === 'cancelled' && transportation.status !== 'cancelled') {
        newStatus = 'cancelled';
        shouldUpdate = true;
      } else if (route.status === 'active' && transportation.status === 'pending') {
        newStatus = 'in_transit';
        shouldUpdate = true;
      } else if (route.status === 'active' && transportation.status === 'in_transit') {
        // Check if arrived at destination
        const lastStop = route.stops[route.stops.length - 1];
        if (lastStop?.status === 'arrived' || lastStop?.status === 'in_progress') {
          newStatus = 'arrived';
          shouldUpdate = true;
        }
      }

      if (shouldUpdate) {
        const updated = await TransportationModel.findByIdAndUpdate(
          transportation._id,
          {
            $set: {
              status: newStatus,
              ...(newStatus === 'completed' && { actualDeliveryTime: new Date() }),
            },
          },
          { new: true, lean: true }
        );
        if (updated) {
          transportation = updated;
        }
      }
    }

    // ── Ensure transportation exists and is a plain object ────────────────────
    const transportationData = transportation 
      ? (typeof transportation.toObject === 'function' 
          ? transportation.toObject() 
          : transportation)
      : null;

    if (!transportationData) {
      socket.emit("route_error", {
        code: "TRANSPORTATION_NOT_FOUND",
        message: "Could not find or create transportation for this route.",
      });
      return;
    }

    const hubRoute = isHubRoute(route.type);
    const stop = route.stops[route.currentStopIndex];
    if (!stop) return;

    // ── Build pending manifests/packages for current stop ──────────────────────
    let pendingManifests: any[] = [];
    if (hubRoute && (stop.manifestIds ?? []).length > 0) {
      pendingManifests = await ManifestModel.find({
        _id: { $in: stop.manifestIds },
      })
        .select(
          "_id manifestCode status packageCount totalDeclaredWeight originBranchId destinationBranchId",
        )
        .lean();
    }

    let pendingPackages: any[] = [];
    if (!hubRoute && stop.packageIds.length > 0) {
      pendingPackages = await PackageModel.find({
        _id: { $in: stop.packageIds },
      })
        .select("_id trackingNumber status destination currentBranchId")
        .lean();
    }

    // ── Check for pending QR session ──────────────────────────────────────────
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

    socket.join(this.getRouteRoom(route._id.toString()));

    const nextStop = route.stops[route.currentStopIndex + 1] ?? null;
    const isLastStop = route.currentStopIndex === route.stops.length - 1;

    // ── Build Transportation Summary Response ──────────────────────────────────
    const transportationResponse = {
      id: transportationData._id,
      transportationCode: transportationData.transportationCode,
      companyId: transportationData.companyId,
      sourceRouteId: transportationData.sourceRouteId,
      // stopIndex: route.currentStopIndex,
      status: transportationData.status,
      manifestCount: transportationData.manifestCount,
      packageCount: transportationData.packageCount,
      totalWeight: transportationData.totalWeight,
      totalVolume: transportationData.totalVolume,
      estimatedDeliveryTime: transportationData.estimatedDeliveryTime ?? null,
      actualDeliveryTime: transportationData.actualDeliveryTime ?? null,
      departedAt: transportationData.departedAt ?? null,
      notes: transportationData.notes ?? null,
      createdAt: transportationData.createdAt,
      updatedAt: transportationData.updatedAt,
      // Virtuals
      isInTransit: transportationData.status === 'in_transit',
      isCompleted: transportationData.status === 'completed',
      isOverdue: transportationData.estimatedDeliveryTime 
        ? new Date() > new Date(transportationData.estimatedDeliveryTime) 
        : false,
      durationMinutes: transportationData.departedAt && transportationData.actualDeliveryTime
        ? Math.round(
            (new Date(transportationData.actualDeliveryTime).getTime() - 
            new Date(transportationData.departedAt).getTime()) / 60000
          )
        : null,
      // Source
      source: transportationData.source ? {
        branchId: transportationData.source.branchId,
        name: transportationData.source.name,
        location: transportationData.source.location,
      } : null,
      // Destination
      destination: transportationData.destination ? {
        branchId: transportationData.destination.branchId,
        name: transportationData.destination.name,
        location: transportationData.destination.location,
      } : null,
      // Assigned
      assignedTransporterId: transportationData.assignedTransporterId,
      assignedVehicleId: transportationData.assignedVehicleId,
    };

    // ── Emit the full session resume with transportation summary ──────────────
    socket.emit("session_resumed", {
      role: "transporter",
      
      // ── Transportation Summary ──────────────────────────────────────────────
      transportation: transportationResponse,

      // ── Route Info ───────────────────────────────────────────────────────────
      routeId: route._id,
      routeNumber: route.routeNumber,
      routeType: route.type,
      routeStatus: route.status,
      isHubRoute: hubRoute,
      
      // ── Progress ─────────────────────────────────────────────────────────────
      currentStopIndex: route.currentStopIndex,
      totalStops: route.stops.length,
      completedStops: route.completedStops,
      remainingStops: route.stops.length - route.currentStopIndex,
      progressPercentage: route.stops.length > 0 
        ? Math.round((route.currentStopIndex / route.stops.length) * 100) 
        : 0,
      
      // ── Timing ──────────────────────────────────────────────────────────────
      scheduledStart: route.scheduledStart,
      actualStart: route.actualStart,
      scheduledEnd: route.scheduledEnd,
      isDelayed: route.scheduledEnd ? new Date() > route.scheduledEnd : false,
      estimatedTimeRemaining: route.estimatedTime && route.actualStart
        ? Math.max(0, route.estimatedTime - ((Date.now() - new Date(route.actualStart).getTime()) / 60000))
        : null,

      // ── Current Stop ────────────────────────────────────────────────────────
      currentStop: stop ? {
        stopId: stop._id,
        stopIndex: route.currentStopIndex,
        status: stop.status,
        address: stop.address,
        location: stop.location.coordinates,
        branchId: stop.branchId,
        action: stop.action,
        isLastStop,
        // Load info
        loadCount: stopLoadCount(stop, route.type),
        loadUnit: hubRoute ? "manifests" : "packages",
        pendingManifestCount: pendingManifests.length,
        totalManifestCount: stop.manifestIds?.length ?? 0,
        pendingManifests: pendingManifests.map((m: any) => ({
          manifestId: m._id,
          manifestCode: m.manifestCode,
          status: m.status,
          packageCount: m.packageCount,
          totalWeight: m.totalDeclaredWeight,
          originBranchId: m.originBranchId,
          destinationBranchId: m.destinationBranchId,
        })),
        pendingPackageCount: pendingPackages.length,
        totalPackageCount: stop.packageIds.length,
        pendingPackages: pendingPackages.map((p: any) => ({
          packageId: p._id,
          trackingNumber: p.trackingNumber,
          status: p.status,
          recipientName: p.destination?.recipientName,
          city: p.destination?.city,
          currentBranchId: p.currentBranchId,
        })),
      } : null,

      // ── Pending QR Session ──────────────────────────────────────────────────
      pendingQrSession,

      // ── Next Stop ───────────────────────────────────────────────────────────
      nextStop: nextStop ? {
        stopIndex: route.currentStopIndex + 1,
        stopId: nextStop._id,
        branchId: nextStop.branchId,
        address: nextStop.address,
        location: nextStop.location.coordinates,
        loadCount: stopLoadCount(nextStop, route.type),
        loadUnit: hubRoute ? "manifests" : "packages",
      } : null,

      // ── Manifest IDs (for quick reference) ─────────────────────────────────
      manifestIds: hubRoute ? stop?.manifestIds ?? [] : [],

      // ── Status Message ──────────────────────────────────────────────────────
      message: route.status === "paused"
        ? "Your route was paused. Tap Resume to continue."
        : pendingQrSession
          ? "QR scan pending. Please scan the code at the branch to complete this stop."
          : transportationData.status === "arrived"
            ? "You have arrived at the destination. Please complete the unloading process."
            : transportationData.status === "in_transit"
              ? "You are currently in transit. Proceed to the next stop."
              : "You have an active route. Pick up where you left off.",
      
      timestamp: new Date(),
    });

    console.log(
      `[Socket] Transporter ${userId} resumed — route ${route.routeNumber} ` +
        `(${route.type}) stop ${route.currentStopIndex}/${route.stops.length - 1} ` +
        `transportation ${transportationData.transportationCode} status=${transportationData.status}`,
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
    
    this.broadcastPackageStatusToClient(packageId, payload.status);
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