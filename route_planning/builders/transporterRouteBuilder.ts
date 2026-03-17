// ─────────────────────────────────────────────────────────────────────────────
//  transporterRouteBuilder.ts
//  Builds inter_branch Route documents: one transporter, one vehicle,
//  N branch stops ordered by nearest-neighbour + 2-opt TSP.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import BranchModel from "../../models/branch.model";
import RouteModel  from "../../models/route.model";
import PackageModel from "../../models/package.model";
import {
  BranchInfo, PackageCandidate, PlannedRoute, PlannedStop,
  StopPoint, VehicleCandidate, WorkerCandidate, Coords,
} from "../types.util";
import { optimisedTSP, annotateArrivalTimes } from "../algorithms/tsp.util";
import { estimatedDriveMinutes } from "../algorithms/haversine.util";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes spent at a branch stop for unloading/handover */
const BRANCH_DWELL_MINUTES = 20;

/** Average speed for inter-branch routes (km/h) */
const ROUTE_TYPE = "inter_branch" as const;

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export interface TransporterRouteBuilderInput {
  packages:       PackageCandidate[];   // already bin-packed for this vehicle
  vehicle:        VehicleCandidate;
  worker:         WorkerCandidate;      // transporter
  originBranch:   BranchInfo;
  totalWeight:    number;
  totalVolume:    number;
  scheduledStart: Date;
}

/**
 * Builds a PlannedRoute for a transporter.
 *
 * Steps:
 *  1. Group packages by destinationBranchId → one stop per destination
 *  2. Fetch coordinates for every destination branch (parallel)
 *  3. Run optimisedTSP (nearest-neighbour + 2-opt) to order stops
 *  4. Annotate each stop with expectedArrival / expectedDeparture
 *  5. Return a PlannedRoute ready to be persisted by the orchestrator
 *
 * Returns null if any destination branch cannot be found (logs the gap).
 */
export async function buildTransporterRoute(
  input: TransporterRouteBuilderInput,
): Promise<PlannedRoute | null> {
  const {
    packages, vehicle, worker, originBranch,
    totalWeight, totalVolume, scheduledStart,
  } = input;

  // ── 1. Group packages by destination branch ─────────────────────────────
  const byDestination = new Map<string, mongoose.Types.ObjectId[]>();

  for (const pkg of packages) {
    if (!pkg.destinationBranchId) continue;
    const key = pkg.destinationBranchId.toString();
    if (!byDestination.has(key)) byDestination.set(key, []);
    byDestination.get(key)!.push(pkg._id);
  }

  if (byDestination.size === 0) return null;

  // ── 2. Fetch destination branch coordinates (parallel) ─────────────────
  const branchIds = [...byDestination.keys()].map(
    (id) => new mongoose.Types.ObjectId(id),
  );

  const branchDocs = await BranchModel.find({ _id: { $in: branchIds } })
    .select("_id name code wilaya location companyId")
    .lean() as any[];

  // Index by string id for fast lookup
  const branchMap = new Map<string, any>(
    branchDocs.map((b) => [b._id.toString(), b]),
  );

  // Check all destination branches were found
  const missingIds = branchIds.filter(
    (id) => !branchMap.has(id.toString()),
  );
  if (missingIds.length > 0) {
    console.warn(
      `[transporterRouteBuilder] ${missingIds.length} destination branch(es) not found — ` +
      `skipping route for transporter ${worker._id}`,
    );
    return null;
  }

  // ── 3. Build StopPoints for TSP ─────────────────────────────────────────
  const stopPoints: StopPoint[] = [];

  for (const [branchIdStr, pkgIds] of byDestination.entries()) {
    const branch = branchMap.get(branchIdStr);
    const coords = branch?.location?.coordinates as Coords | undefined;

    if (!coords || coords.length !== 2) {
      console.warn(
        `[transporterRouteBuilder] Branch ${branchIdStr} has no coordinates — skipped`,
      );
      return null;
    }

    stopPoints.push({
      id:          branchIdStr,
      coordinates: coords,
      packageIds:  pkgIds,
      meta:        { branchName: branch.name, branchCode: branch.code },
    });
  }

  // ── 4. TSP ordering ──────────────────────────────────────────────────────
  const tspResult = optimisedTSP(
    originBranch.coordinates,
    stopPoints,
    ROUTE_TYPE,
  );

  const annotated = annotateArrivalTimes(
    tspResult,
    scheduledStart,
    BRANCH_DWELL_MINUTES,
  );

  // ── 5. Build PlannedStop list ────────────────────────────────────────────
  const plannedStops: PlannedStop[] = annotated.annotatedStops.map(
    (stop, idx) => {
      const branchOid = new mongoose.Types.ObjectId(stop.id);
      const isLastStop = idx === annotated.annotatedStops.length - 1;

      return {
        branchId:        branchOid,
        coordinates:     stop.coordinates,
        address:         stop.meta?.branchName ?? stop.id,
        packageIds:      stop.packageIds,
        // Last stop = "transfer" (final handoff); intermediate = "transfer" too
        // Both use "transfer" because transporter hands packages to branch staff,
        // not to end clients. "delivery" is reserved for deliverer→client handoff.
        action:          "transfer",
        dwellMinutes:    BRANCH_DWELL_MINUTES,
        expectedArrival: stop.expectedArrival,
      };
    },
  );

  // ── 6. Compute total time (drive + all dwell) ────────────────────────────
  const totalDriveMinutes = tspResult.segmentDriveMinutes.reduce(
    (a, b) => a + b, 0,
  );
  const totalDwellMinutes = plannedStops.length * BRANCH_DWELL_MINUTES;
  const estimatedTime     = totalDriveMinutes + totalDwellMinutes;

  const scheduledEnd = new Date(
    scheduledStart.getTime() + estimatedTime * 60_000,
  );

  // The "destination" of a transporter route = the last stop
  const lastStop = annotated.annotatedStops[annotated.annotatedStops.length - 1];
  const destinationBranchId = lastStop
    ? new mongoose.Types.ObjectId(lastStop.id)
    : undefined;

  // ── 7. Flat package ID list ──────────────────────────────────────────────
  const allPackageIds = packages.map((p) => p._id);

  return {
    type:                   "inter_branch",
    companyId:              originBranch.companyId,
    originBranchId:         originBranch._id,
    destinationBranchId,
    assignedVehicleId:      vehicle._id,
    assignedTransporterId:  worker._id,
    stops:                  plannedStops,
    totalWeight,
    totalVolume,
    estimatedDistanceKm:    tspResult.totalDistanceKm,
    estimatedTime,
    scheduledStart,
    scheduledEnd,
    packageIds:             allPackageIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PERSIST
//  Saves the PlannedRoute as a RouteModel document and updates package
//  currentRouteId references — all inside the caller's session.
// ─────────────────────────────────────────────────────────────────────────────

export async function persistTransporterRoute(
  planned:   PlannedRoute,
  session:   mongoose.ClientSession,
): Promise<mongoose.Types.ObjectId> {
  const routeNumber = generateRouteNumber(planned.scheduledStart);

  // Map PlannedStop → IRouteStop shape expected by RouteModel
  const stops = planned.stops.map((stop, idx) => ({
    order:              idx + 1,
    action:             stop.action,
    location: {
      type:             "Point" as const,
      coordinates:      stop.coordinates,
    },
    address:            stop.address,
    branchId:           stop.branchId,
    packageIds:         stop.packageIds,
    expectedArrival:    stop.expectedArrival,
    status:             "pending" as const,
    stopDuration:       stop.dwellMinutes,
    completedPackages:  [],
    failedPackages:     [],
    skippedPackages:    [],
  }));

  const [route] = await RouteModel.create(
    [
      {
        routeNumber,
        companyId:              planned.companyId,
        name:                   `Inter-branch route ${routeNumber}`,
        type:                   planned.type,
        originBranchId:         planned.originBranchId,
        destinationBranchId:    planned.destinationBranchId,
        assignedVehicleId:      planned.assignedVehicleId,
        assignedTransporterId:  planned.assignedTransporterId,
        stops,
        distance:               parseFloat(planned.estimatedDistanceKm.toFixed(2)),
        estimatedTime:          planned.estimatedTime,
        status:                 "assigned",
        currentStopIndex:       0,
        completedStops:         0,
        failedStops:            0,
        skippedStops:           0,
        scheduledStart:         planned.scheduledStart,
        scheduledEnd:           planned.scheduledEnd,
      },
    ],
    { session },
  );

  // Stamp packages with their route ID
  await PackageModel.updateMany(
    { _id: { $in: planned.packageIds } },
    { $set: { currentRouteId: route._id } },
    { session },
  );

  return route._id as mongoose.Types.ObjectId;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let routeCounter = 0; // resets per process restart — fine for a nightly batch

function generateRouteNumber(date: Date): string {
  routeCounter = (routeCounter + 1) % 10000;
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, "");
  const seq      = String(routeCounter).padStart(3, "0");
  return `R-${yyyymmdd}-${seq}`;
}