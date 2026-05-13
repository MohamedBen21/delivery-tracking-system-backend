import axios, { AxiosError } from "axios";

// ── Config ────────────────────────────────────────────────────────────────────
const OPTIMIZER_URL        = process.env.OPTIMIZER_URL        ?? "http://localhost:8000";
const OPTIMIZER_TIMEOUT_MS = parseInt(process.env.OPTIMIZER_TIMEOUT_MS ?? "30000");

const optimizerClient = axios.create({
  baseURL: OPTIMIZER_URL,
  timeout: OPTIMIZER_TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

// ── Request types (mirrors Python api/models.py) ──────────────────────────────

export interface OptimizerBranch {
  _id: string;
  coordinates: [number, number];   // [lng, lat]
}

export interface OptimizerPackage {
  _id:              string;
  weight:           number;
  volume:           number;
  isFragile:        boolean;
  deliveryType:     "home" | "branch_pickup";
  deliveryPriority: "standard" | "express" | "same_day";
  destinationBranchId?: string;
  destination?: {
    coordinates:    [number, number];
    recipientName:  string;
    recipientPhone: string;
    address:        string;
    city:           string;
    state:          string;
  };
}

/**
 * A sealed manifest bag carried on a hub transporter route.
 * Python treats this as its unit of load — the same role a single package
 * plays on a deliverer route.
 *
 * Node.js is responsible for resolving destinationCoordinates before the call
 * (Python has no DB access).
 */
export interface OptimizerManifest {
  _id:                    string;
  manifestCode:           string;
  totalWeight:            number;    // kg — sum of all packages inside
  totalVolume:            number;    // m³ — 0 when not tracked at manifest level
  packageCount:           number;    // informational
  /** Branch where this manifest currently sits (its physical origin for this leg). */
  originBranchId:         string;
  /** Coordinates of the origin branch, resolved by Node.js. */
  originCoordinates:      [number, number];
  destinationBranchId:    string;
  /** Coordinates of the destination branch, resolved by Node.js. */
  destinationCoordinates: [number, number];
  priority:               "standard" | "express" | "urgent";
}

export interface OptimizerVehicle {
  _id:                string;
  type:               string;
  maxWeight:          number;
  maxVolume:          number;
  supportsFragile:    boolean;
  registrationNumber: string;
}

export interface OptimizerWorker {
  _id:    string;
  userId: string;
  role:   "transporter" | "deliverer";

  // Hub model fields — optional; omit for deliverers and legacy transporters.

  /**
   * Sub-type of this transporter.
   * "hub_to_hub"    → carries manifests directly between two main hubs.
   * "hub_to_branch" → delivers manifests from a main hub to local branches.
   */
  transporterType?: "hub_to_hub" | "hub_to_branch";

  /**
   * hub_to_hub only.
   * [originHubId, destinationHubId] for this trip leg.
   * The Python optimizer uses this to match workers to manifests going
   * to the right destination hub.
   */
  assignedLine?: [string, string];

  /**
   * hub_to_branch only.
   * The branch IDs this transporter serves from their home hub.
   * Python will only build stops for branches present in this list.
   */
  assignedBranches?: string[];
}

export interface OptimizerRequest {
  branch:   OptimizerBranch;
  vehicles: OptimizerVehicle[];
  workers:  OptimizerWorker[];
  /** Raw packages — used for deliverer and legacy transporter passes. */
  packages: OptimizerPackage[];
  /** Sealed manifests — used for hub_to_hub and hub_to_branch transporter passes. */
  manifests: OptimizerManifest[];
}

// ── Response types ────────────────────────────────────────────────────────────

export interface OptimizerStop {
  coordinates:          [number, number];
  /** Package IDs at this stop (deliverer / legacy transporter routes). */
  packageIds:           string[];
  /** Manifest IDs at this stop (hub transporter routes). */
  manifestIds:          string[];
  address?:             string;
  recipientName?:       string;
  destinationBranchId?: string;
}

export interface OptimizerRoute {
  vehicleId:            string;
  workerId:             string;
  /**
   * Route type returned by Python.
   * "hub_to_hub"    — direct manifest leg between two main hubs.
   * "hub_to_branch" — multi-stop manifest run from hub to local branches.
   * "local_delivery"— last-mile package delivery to customers.
   * (legacy "inter_branch" still returned for non-hub transporter routes)
   */
  routeType:            "hub_to_hub" | "hub_to_branch" | "inter_branch" | "local_delivery";
  stops:                OptimizerStop[];
  /**
   * For hub_to_hub routes: the hub this leg departs from.
   * May differ from the planning hub for return legs (hub B → hub A).
   * Node.js must use this as originBranchId on the persisted RouteModel document.
   */
  originBranchId?:      string;
  /** Package IDs on this route (empty for hub routes). */
  packageIds:           string[];
  /** Manifest IDs on this route (empty for deliverer / legacy routes). */
  manifestIds:          string[];
  totalWeight:          number;
  totalVolume:          number;
  distanceKm:           number;
  estimatedTimeMinutes: number;
  distanceSource:       "osrm" | "haversine" | "n/a";
}

export interface OptimizerResponse {
  routes:      OptimizerRoute[];
  /** Packages that could not be assigned to any vehicle. */
  unscheduled: { packageId: string; reason: string }[];
  /** Manifests that could not be assigned to any vehicle. */
  unscheduledManifests: { manifestId: string; reason: string }[];
  meta: {
    durationMs:              number;
    totalPackages:           number;
    totalManifests:          number;
    scheduledPackages:       number;
    scheduledManifests:      number;
    unscheduledPackages:     number;
    unscheduledManifests:    number;
    routesCreated:           number;
  };
}

// ── Client functions ──────────────────────────────────────────────────────────

/**
 * Calls the Python CVRP optimizer and returns optimized routes.
 * Throws on network error or non-200 response.
 */
export async function callOptimizer(
  payload: OptimizerRequest,
): Promise<OptimizerResponse> {
  try {
    const { data } = await optimizerClient.post<OptimizerResponse>(
      "/optimize",
      payload,
    );
    return data;
  } catch (err) {
    const axiosErr = err as AxiosError;
    const detail   = axiosErr.response?.data
      ? JSON.stringify(axiosErr.response.data)
      : axiosErr.message;
    throw new Error(`Optimizer service failed: ${detail}`);
  }
}

/**
 * Health check — call this on startup to verify the Python service is reachable.
 */
export async function pingOptimizer(): Promise<boolean> {
  try {
    const { data } = await optimizerClient.get("/health");
    return data?.status === "ok";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Thin HTTP client that calls the Python CVRP optimizer.
//
//  Node.js responsibilities (ONLY):
//    1. Fetch packages, manifests, vehicles, workers from MongoDB
//    2. Resolve branch coordinates for manifests before the call
//    3. Call this client with the assembled data
//    4. Persist the result (routes, manifest transport legs, worker/vehicle status)
//
//  Python handles everything in between (assignment + route ordering).
// ─────────────────────────────────────────────────────────────────────────────