import axios, { AxiosError } from "axios";

// ── Config ────────────────────────────────────────────────────────────────────
const OPTIMIZER_URL  = process.env.OPTIMIZER_URL  ?? "http://localhost:8000";
const OPTIMIZER_TIMEOUT_MS = parseInt(process.env.OPTIMIZER_TIMEOUT_MS ?? "30000");

const optimizerClient = axios.create({
  baseURL: OPTIMIZER_URL,
  timeout: OPTIMIZER_TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

// ── Request / Response types (mirrors Python api/models.py) ──────────────────

export interface OptimizerBranch {
  _id: string;
  coordinates: [number, number];  // [lng, lat]
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
    coordinates:   [number, number];
    recipientName: string;
    recipientPhone:string;
    address:       string;
    city:          string;
    state:         string;
  };
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
}

export interface OptimizerRequest {
  branch:   OptimizerBranch;
  vehicles: OptimizerVehicle[];
  workers:  OptimizerWorker[];
  packages: OptimizerPackage[];
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface OptimizerStop {
  coordinates:       [number, number];
  packageIds:        string[];
  address?:          string;
  recipientName?:    string;
  destinationBranchId?: string;
}

export interface OptimizerRoute {
  vehicleId:             string;
  workerId:              string;
  routeType:             "inter_branch" | "local_delivery";
  stops:                 OptimizerStop[];
  packageIds:            string[];
  totalWeight:           number;
  totalVolume:           number;
  distanceKm:            number;
  estimatedTimeMinutes:  number;
  distanceSource:        "osrm" | "haversine";
}

export interface OptimizerResponse {
  routes:      OptimizerRoute[];
  unscheduled: { packageId: string; reason: string }[];
  meta: {
    durationMs:     number;
    totalPackages:  number;
    scheduled:      number;
    unscheduled:    number;
    routesCreated:  number;
  };
}

// ── Client function ───────────────────────────────────────────────────────────

/**
 * Calls the Python CVRP optimizer and returns optimized routes.
 *
 * Throws on network error or non-200 response — the orchestrator's
 * try/catch handles this and marks the branch as failed.
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
//    1. Fetch packages, vehicles, workers from MongoDB
//    2. Call this client with the raw data
//    3. Persist the result (routes, worker/vehicle status updates)
//
//  Python handles everything in between.
// ─────────────────────────────────────────────────────────────────────────────