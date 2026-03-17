// ─────────────────────────────────────────────────────────────────────────────
//  delivererRouteBuilder.ts
//  Builds local_delivery Route documents: one deliverer, one vehicle,
//  N client-address stops ordered by nearest-neighbour + 2-opt TSP.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import RouteModel   from "../../models/route.model";
import PackageModel from "../../models/package.model";
import {
  BranchInfo, PackageCandidate, PlannedRoute, PlannedStop,
  StopPoint, VehicleCandidate, WorkerCandidate, Coords,
} from "../types.util";
import { optimisedTSP, annotateArrivalTimes } from "../algorithms/tsp.util";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes at a client address: ring bell, hand over, get signature */
const CLIENT_DWELL_MINUTES = 8;

const ROUTE_TYPE = "local_delivery" as const;

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export interface DelivererRouteBuilderInput {
  packages:       PackageCandidate[];   // already bin-packed for this vehicle
  vehicle:        VehicleCandidate;
  worker:         WorkerCandidate;      // deliverer
  originBranch:   BranchInfo;
  totalWeight:    number;
  totalVolume:    number;
  scheduledStart: Date;
}

/**
 * Builds a PlannedRoute for a deliverer.
 *
 * Steps:
 *  1. Group packages that share the exact same coordinates into one stop
 *     (same building / same household — avoid duplicate stops)
 *  2. Run optimisedTSP to order stops
 *  3. Annotate stops with expectedArrival / expectedDeparture
 *  4. Return a PlannedRoute ready to be persisted
 *
 * Packages without destination.coordinates are filtered out before this
 * function is called (packageCandidateService handles that).
 */
export async function buildDelivererRoute(
  input: DelivererRouteBuilderInput,
): Promise<PlannedRoute | null> {
  const {
    packages, vehicle, worker, originBranch,
    totalWeight, totalVolume, scheduledStart,
  } = input;

  if (packages.length === 0) return null;

  // ── 1. Group packages by coordinates ────────────────────────────────────
  // Key = "lng,lat" rounded to 5 decimal places (~1m precision)
  // Multiple packages to the same address → one stop, multiple packageIds
  const byCoords = new Map<string, {
    coords:     Coords;
    packageIds: mongoose.Types.ObjectId[];
    meta:       { recipientName: string; recipientPhone: string; address: string };
  }>();

  for (const pkg of packages) {
    if (!pkg.destination?.coordinates) continue;

    const [lng, lat] = pkg.destination.coordinates;
    const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;

    if (!byCoords.has(key)) {
      byCoords.set(key, {
        coords:     [lng, lat],
        packageIds: [],
        meta: {
          recipientName:  pkg.destination.recipientName,
          recipientPhone: pkg.destination.recipientPhone,
          address:        pkg.destination.address,
        },
      });
    }

    byCoords.get(key)!.packageIds.push(pkg._id);
  }

  if (byCoords.size === 0) return null;

  // ── 2. Build StopPoints for TSP ─────────────────────────────────────────
  const stopPoints: StopPoint[] = [...byCoords.entries()].map(
    ([coordKey, stop]) => ({
      id:          coordKey,
      coordinates: stop.coords,
      packageIds:  stop.packageIds,
      meta:        stop.meta,
    }),
  );

  // ── 3. TSP ordering ──────────────────────────────────────────────────────
  const tspResult = optimisedTSP(
    originBranch.coordinates,
    stopPoints,
    ROUTE_TYPE,
  );

  const annotated = annotateArrivalTimes(
    tspResult,
    scheduledStart,
    CLIENT_DWELL_MINUTES,
  );

  // ── 4. Build PlannedStop list ────────────────────────────────────────────
  const plannedStops: PlannedStop[] = annotated.annotatedStops.map((stop) => ({
    coordinates:     stop.coordinates,
    address:         stop.meta?.address  ?? "",
    packageIds:      stop.packageIds,
    action:          "delivery",
    dwellMinutes:    CLIENT_DWELL_MINUTES,
    expectedArrival: stop.expectedArrival,
    // clientId: not stored here — the package itself holds clientId
    // Keeping stops lean; the deliverer app resolves recipient from the package
  }));

  // ── 5. Compute total time ────────────────────────────────────────────────
  const totalDriveMinutes = tspResult.segmentDriveMinutes.reduce(
    (a, b) => a + b, 0,
  );
  const totalDwellMinutes = plannedStops.length * CLIENT_DWELL_MINUTES;
  const estimatedTime     = totalDriveMinutes + totalDwellMinutes;

  const scheduledEnd = new Date(
    scheduledStart.getTime() + estimatedTime * 60_000,
  );

  return {
    type:                  "local_delivery",
    companyId:             originBranch.companyId,
    originBranchId:        originBranch._id,
    assignedVehicleId:     vehicle._id,
    assignedDelivererId:   worker._id,
    stops:                 plannedStops,
    totalWeight,
    totalVolume,
    estimatedDistanceKm:   tspResult.totalDistanceKm,
    estimatedTime,
    scheduledStart,
    scheduledEnd,
    packageIds:            packages.map((p) => p._id),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PERSIST
// ─────────────────────────────────────────────────────────────────────────────

export async function persistDelivererRoute(
  planned:   PlannedRoute,
  session:   mongoose.ClientSession,
): Promise<mongoose.Types.ObjectId> {
  const routeNumber = generateRouteNumber(planned.scheduledStart);

  const stops = planned.stops.map((stop, idx) => ({
    order:             idx + 1,
    action:            stop.action,
    location: {
      type:            "Point" as const,
      coordinates:     stop.coordinates,
    },
    address:           stop.address,
    packageIds:        stop.packageIds,
    expectedArrival:   stop.expectedArrival,
    status:            "pending" as const,
    stopDuration:      stop.dwellMinutes,
    completedPackages: [],
    failedPackages:    [],
    skippedPackages:   [],
  }));

  const [route] = await RouteModel.create(
    [
      {
        routeNumber,
        companyId:            planned.companyId,
        name:                 `Delivery route ${routeNumber}`,
        type:                 planned.type,
        originBranchId:       planned.originBranchId,
        assignedVehicleId:    planned.assignedVehicleId,
        assignedDelivererId:  planned.assignedDelivererId,
        stops,
        distance:             parseFloat(planned.estimatedDistanceKm.toFixed(2)),
        estimatedTime:        planned.estimatedTime,
        status:               "assigned",
        currentStopIndex:     0,
        completedStops:       0,
        failedStops:          0,
        skippedStops:         0,
        scheduledStart:       planned.scheduledStart,
        scheduledEnd:         planned.scheduledEnd,
      },
    ],
    { session },
  );

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

let routeCounter = 0;

function generateRouteNumber(date: Date): string {
  routeCounter = (routeCounter + 1) % 10000;
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, "");
  const seq      = String(routeCounter).padStart(3, "0");
  return `R-${yyyymmdd}-${seq}`;
}