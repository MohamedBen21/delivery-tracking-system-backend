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
    // this.setupSocketHandlers();
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
  
}