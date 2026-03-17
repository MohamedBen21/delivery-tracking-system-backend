import mongoose from "mongoose";



/** [longitude, latitude] */
export type Coords = [number, number];

// ── Package ───────────────────────────────────────────────────────────────────

export type DeliveryPriority = "standard" | "express" | "same_day";
export type DeliveryType     = "home" | "branch_pickup";

/**
 * Minimal package representation used by bin-packing and route builders.
 * Projected from PackageModel — no virtual fields, no trackingHistory.
 */
export interface PackageCandidate {
  _id:              mongoose.Types.ObjectId;
  weight:           number;           // kg
  volume:           number;           // m³  (always set — pre-save seeds it)
  isFragile:        boolean;
  deliveryType:     DeliveryType;
  deliveryPriority: DeliveryPriority;

  // Transporter routes — which branch this package is going to next
  destinationBranchId?: mongoose.Types.ObjectId;

  // Deliverer routes — where to physically deliver it
  destination?: {
    coordinates:    Coords;           // required for deliverer routing
    recipientName:  string;
    recipientPhone: string;
    address:        string;
    city:           string;
    state:          string;           // wilaya
  };
}

// ── Vehicle ───────────────────────────────────────────────────────────────────

export type VehicleType = "motorcycle" | "car" | "van" | "small_truck" | "large_truck";

/** Ordered from lightest to heaviest — used by vehicle picker */
export const VEHICLE_TYPE_ORDER: VehicleType[] = [
  "motorcycle",
  "car",
  "van",
  "small_truck",
  "large_truck",
];

export interface VehicleCandidate {
  _id:                mongoose.Types.ObjectId;
  type:               VehicleType;
  maxWeight:          number;         // kg
  maxVolume:          number;         // m³
  supportsFragile:    boolean;
  registrationNumber: string;
}

// ── Worker ────────────────────────────────────────────────────────────────────

export type WorkerRole = "transporter" | "deliverer";

export interface WorkerCandidate {
  _id:       mongoose.Types.ObjectId;  // Transporter / Deliverer doc _id
  userId:    mongoose.Types.ObjectId;
  role:      WorkerRole;
  vehicleId?: mongoose.Types.ObjectId; // pre-assigned if any
}

// ── Branch (lean) ─────────────────────────────────────────────────────────────

export interface BranchInfo {
  _id:         mongoose.Types.ObjectId;
  name:        string;
  code:        string;
  wilaya:      string;
  coordinates: Coords;
  companyId:   mongoose.Types.ObjectId;
}

// ── Bin packing ───────────────────────────────────────────────────────────────

export interface LoadResult {
  loaded:             PackageCandidate[];
  leftover:           PackageCandidate[];
  totalWeight:        number;
  totalVolume:        number;
  utilizationWeight:  number;   // 0–1 fraction of vehicle maxWeight used
  utilizationVolume:  number;   // 0–1 fraction of vehicle maxVolume used
}

// ── TSP ───────────────────────────────────────────────────────────────────────

/** One stop fed into the TSP solver */
export interface StopPoint {
  /** Unique key: branchId.toString() or clientUserId.toString() */
  id:          string;
  coordinates: Coords;
  packageIds:  mongoose.Types.ObjectId[];
  /** Pass-through — builders attach extra data here */
  meta?:       Record<string, any>;
}


export interface TSPResult {
  orderedStops:      StopPoint[];
  totalDistanceKm:   number;
  /** km for each leg: segmentDistances[i] = distance from stop i to stop i+1 */
  segmentDistances:  number[];
  /** minutes for each leg (drive only, no dwell time) */
  segmentDriveMinutes: number[];
}

// ── Planned route (output of builders, input to RouteModel.create) ─────────────

export type StopAction = "pickup" | "delivery" | "transfer";

export interface PlannedStop {
  branchId?:      mongoose.Types.ObjectId;   // transporter stops
  clientId?:      mongoose.Types.ObjectId;   // deliverer stops (User._id)
  coordinates:    Coords;
  address?:       string;
  packageIds:     mongoose.Types.ObjectId[];
  action:         StopAction;
  /** Minutes expected to spend at this stop (unloading / handing over) */
  dwellMinutes:   number;
  expectedArrival?: Date;
}



export interface PlannedRoute {
  type:                    "inter_branch" | "local_delivery";
  companyId:               mongoose.Types.ObjectId;
  originBranchId:          mongoose.Types.ObjectId;
  destinationBranchId?:    mongoose.Types.ObjectId;   // last stop for transporter
  assignedVehicleId:       mongoose.Types.ObjectId;
  assignedTransporterId?:  mongoose.Types.ObjectId;
  assignedDelivererId?:    mongoose.Types.ObjectId;
  stops:                   PlannedStop[];
  totalWeight:             number;
  totalVolume:             number;
  estimatedDistanceKm:     number;
  estimatedTime:           number;                    // minutes (drive + dwell)
  scheduledStart:          Date;
  scheduledEnd:            Date;
  packageIds:              mongoose.Types.ObjectId[]; // flat list for quick lookup
}


// ── Orchestrator result ───────────────────────────────────────────────────────

export interface BranchPlanResult {
  branchId:             mongoose.Types.ObjectId;
  branchName:           string;
  transporterRoutes:    number;
  delivererRoutes:      number;
  packagesScheduled:    number;
  packagesUnscheduled:  number;
  errors:               string[];
  durationMs:           number;
}


export interface DailyPlanResult {
  date:               Date;
  totalRoutes:        number;
  totalScheduled:     number;
  totalUnscheduled:   number;
  branchResults:      BranchPlanResult[];
  totalDurationMs:    number;
}