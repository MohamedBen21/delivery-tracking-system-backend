import mongoose from "mongoose";
import BranchModel from "../models/branch.model";
import ManifestModel from "../models/manifest.model";

import {
  BranchInfo, BranchPlanResult, DailyPlanResult,
} from "./types.util";
import {
  getTransporterCandidates,
  getDelivererCandidates,
} from "./services/packageCandidate.service";
import {
  getVehiclesByIds,
  markVehicleInUse,
} from "./services/vehicleAssignment.service";
import {
  getAvailableTransporters,
  getAvailableDeliverers,
  markTransporterAssigned,
  markDelivererAssigned,
} from "./services/workerAssignment.service";
import {
  callOptimizer,
  OptimizerManifest,
  OptimizerRequest,
  OptimizerRoute,
  OptimizerWorker,
} from "./services/optimizerClient";
import RouteModel   from "../models/route.model";
import PackageModel from "../models/package.model";
import { haversineKm } from "./algorithms/haversine.util";


// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const OSRM_URL             = process.env.OSRM_URL        ?? "http://localhost:5000";
const OSRM_TIMEOUT_MS      = parseInt(process.env.OSRM_TIMEOUT_MS ?? "15000");
/**
 * Road-to-straight-line correction factor for Algeria intercity routes.
 * Haversine gives the straight-line ("as the crow flies") distance.
 * Algerian intercity roads average ~40% longer due to terrain and routing.
 * Applied only when OSRM is unavailable.
 */
const HAVERSINE_ROAD_FACTOR = 1.4;
/** Average intercity driving speed (km/h) for hub-to-hub time estimates. */
const HUB_TO_HUB_SPEED_KMH  = 90;
/** Dwell time at destination hub for manifest handover (minutes). */
const HUB_HUB_DWELL_MINUTES  = 30;


// ─────────────────────────────────────────────────────────────────────────────
//  DAILY PLAN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export async function runDailyRoutePlanning(
  scheduledDate: Date,
): Promise<DailyPlanResult> {
  const planStart = Date.now();

  const branches = await BranchModel.find({
    status: "active",
    "location.coordinates": { $exists: true, $ne: [] },
  })
    .select("_id name code wilaya location companyId branchType servesBranches")
    .lean() as any[];

  if (branches.length === 0) {
    return {
      date: scheduledDate, totalRoutes: 0,
      totalScheduled: 0, totalUnscheduled: 0,
      branchResults: [], totalDurationMs: Date.now() - planStart,
    };
  }

  const settled = await Promise.allSettled(
    branches.map((branch) =>
      planBranch(
        {
          _id:         branch._id,
          name:        branch.name,
          code:        branch.code,
          wilaya:      branch.wilaya ?? "",
          coordinates: branch.location.coordinates,
          companyId:   branch.companyId,
        },
        scheduledDate,
        branch.branchType === "regional_main_hub",
      ),
    ),
  );

  const branchResults: BranchPlanResult[] = settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const branch = branches[i];
    console.error(`[orchestrator] Branch ${branch.name} failed:`, result.reason);
    return {
      branchId: branch._id, branchName: branch.name,
      transporterRoutes: 0, delivererRoutes: 0,
      packagesScheduled: 0, packagesUnscheduled: 0,
      manifestsScheduled: 0, manifestsUnscheduled: 0,
      errors: [(result.reason as Error)?.message ?? "Unknown error"],
      durationMs: 0,
    };
  });

  const totalRoutes      = branchResults.reduce((s, b) => s + b.transporterRoutes + b.delivererRoutes, 0);
  const totalScheduled   = branchResults.reduce((s, b) => s + b.packagesScheduled, 0);
  const totalUnscheduled = branchResults.reduce((s, b) => s + b.packagesUnscheduled, 0);

  return {
    date: scheduledDate, totalRoutes, totalScheduled, totalUnscheduled,
    branchResults, totalDurationMs: Date.now() - planStart,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
//  PER-BRANCH / PER-HUB PLANNER
// ─────────────────────────────────────────────────────────────────────────────

async function planBranch(
  branch: BranchInfo,
  scheduledDate: Date,
  isHub: boolean = false,
): Promise<BranchPlanResult> {
  const t0     = Date.now();
  const errors: string[] = [];

  // ── 1. Fetch workers and packages ─────────────────────────────────────────
  const [
    transporterPkgs,
    delivererResult,
    transporters,
    deliverers,
  ] = await Promise.all([
    getTransporterCandidates(branch._id, branch.companyId, isHub),
    getDelivererCandidates(branch._id, branch.companyId),
    getAvailableTransporters(branch._id, branch.companyId, scheduledDate),
    getAvailableDeliverers(branch._id, branch.companyId, scheduledDate),
  ]);

  for (const s of delivererResult.skipped) {
    errors.push(`Package ${s._id}: ${s.reason}`);
  }

  const delivererPkgs = delivererResult.candidates;
  const allPackages   = [...transporterPkgs, ...delivererPkgs];

  // ── 2. Build vehicles list from worker pre-assigned vehicles ──────────────
  //    Fix (Problem 1 & 4): Workers already have vehicles assigned by manager.
  //    We collect vehicle IDs from workers and fetch them.
  const allWorkers = [...transporters, ...deliverers];
  
  // Collect unique vehicle IDs from workers who have a vehicle assigned
  const vehicleIds = allWorkers
    .map((w) => w.vehicleId)
    .filter((id): id is mongoose.Types.ObjectId => id !== undefined && id !== null);
  
  // Remove duplicates
  const uniqueVehicleIds = [...new Set(vehicleIds.map(id => id.toString()))].map(id => new mongoose.Types.ObjectId(id));
  
  // Fetch vehicles by their IDs (no status filtering - they can be "in_use")
  const vehicles = await getVehiclesByIds(uniqueVehicleIds, branch.companyId);

  // ── 3. Fetch manifests for hub transporters at this branch ────────────────
  //
  //  A hub transporter's manifests are those that are:
  //    • status: "sealed" or "loaded"  (ready to travel)
  //    • originBranchId: this branch   (staged here for departure)
  //
  //  We fetch the full transporter documents (with assignedLine /
  //  assignedBranches) so we can:
  //    a) Filter manifests to only those whose destinationBranchId is
  //       reachable by at least one worker.
  //    b) Resolve destination branch coordinates before sending to Python.

  // Hub fields (transporterType, assignedLine, assignedBranches) are already
  // on each WorkerCandidate — getAvailableTransporters now projects them,
  // so no second TransporterModel query is needed here.

  // Manifests are only relevant at hubs.  Skip this entire block for regular
  // local_branch nodes — they only deal with raw packages.

  const reachableHubDestinations = new Set<string>();  // for hub_to_branch
  const hub_to_hub_partnerIds    = new Set<string>();  // for hub_to_hub return fetch

  if (isHub) {
    for (const t of transporters) {
      if (t.transporterType === "hub_to_hub" && t.assignedLine) {

        t.assignedLine.forEach((id) => {
          reachableHubDestinations.add(id.toString());
          // The "partner" hub is the OTHER hub in the line (not this one)
          if (id.toString() !== branch._id.toString()) {
            hub_to_hub_partnerIds.add(id.toString());

          }
        });
      }
      if (t.transporterType === "hub_to_branch" && t.assignedBranches) {
        t.assignedBranches.forEach((id) => reachableHubDestinations.add(id.toString()));
      }
    }
    if (reachableHubDestinations.size === 0 && transporters.some((t) => t.transporterType)) {
      console.warn(
        `[orchestrator] Hub ${branch.name} has hub-type transporters but none have ` +
        `assignedLine/assignedBranches configured — no manifests will be fetched.`,
      );
    }
  }


  // ── Fetch manifests (hubs only) ───────────────────────────────────────────
  //
  // OUTBOUND: manifests sitting at THIS hub, going to any reachable hub/branch.
  // RETURN  : manifests sitting at PARTNER hubs, going back to THIS hub.
  //           These are fetched so the optimizer can plan T1's return leg in
  //           the same planning run — T1 drops outbound at hub B and picks up
  //           the pre-built return route immediately, same night.
  //
  // Both sets are merged into a single `manifests` array for the optimizer.
  // Python distinguishes them by originBranchId on each manifest.


  const [outboundRaw, returnRaw] = isHub && reachableHubDestinations.size > 0
    ? await Promise.all([
        // Outbound: this hub → destinations
        ManifestModel
          .find({
            originBranchId:      branch._id,
            status:              { $in: ["sealed", "loaded"] },
            destinationBranchId: { $in: Array.from(reachableHubDestinations) },
          })
          .select("_id manifestCode totalDeclaredWeight packageCount originBranchId destinationBranchId status priority")
          .lean(),

        // Return: partner hubs → this hub (for hub_to_hub lines only)
        hub_to_hub_partnerIds.size > 0
          ? ManifestModel
              .find({
                originBranchId:      { $in: Array.from(hub_to_hub_partnerIds) },
                destinationBranchId: branch._id,
                status:              { $in: ["sealed", "loaded"] },
              })
              .select("_id manifestCode totalDeclaredWeight packageCount originBranchId destinationBranchId status priority")
              .lean()
          : Promise.resolve([]),
      ])
    : [[], []];

  const rawManifests = [...outboundRaw, ...returnRaw];

  // Resolve branch coordinates for both origins and destinations
  // (Python needs them — it has no DB access)
  const allBranchIdsNeeded = [...new Set([
    ...rawManifests.map((m: any) => m.destinationBranchId.toString()),
    ...rawManifests.map((m: any) => m.originBranchId.toString()),
  ])];

  const coordBranches = allBranchIdsNeeded.length > 0
    ? await BranchModel
        .find({ _id: { $in: allBranchIdsNeeded } })
        .select("_id location")
        .lean()
    : [];

  const branchCoordMap = new Map<string, [number, number]>(
    coordBranches
      .filter((b: any) => b.location?.coordinates?.length === 2)
      .map((b: any) => [b._id.toString(), b.location.coordinates as [number, number]]),
  );

  // Build OptimizerManifest list — drop manifests with missing coordinates
  const optimizerManifests: OptimizerManifest[] = [];

  for (const m of rawManifests as any[]) {

    const destCoords   = branchCoordMap.get(m.destinationBranchId.toString());
    const originCoords = branchCoordMap.get(m.originBranchId.toString());

    if (!destCoords) {

      errors.push(`Manifest ${m._id}: destination branch ${m.destinationBranchId} has no coordinates — skipped`);
      continue;

    }
    if (!originCoords) {

      errors.push(`Manifest ${m._id}: origin branch ${m.originBranchId} has no coordinates — skipped`);
      continue;

    }
    optimizerManifests.push({

      _id:                    m._id.toString(),
      manifestCode:           m.manifestCode,
      totalWeight:            m.totalDeclaredWeight ?? 0,
      totalVolume:            0,
      packageCount:           m.packageCount ?? 0,
      originBranchId:         m.originBranchId.toString(),
      originCoordinates:      originCoords,
      destinationBranchId:    m.destinationBranchId.toString(),
      destinationCoordinates: destCoords,
      priority:               (m.priority as "standard" | "express" | "urgent") ?? "standard",
      
    });
  }

  // ── 4. Early-exit if nothing to do ────────────────────────────────────────
  if (allPackages.length === 0 && optimizerManifests.length === 0) {
    return {
      branchId: branch._id, branchName: branch.name,
      transporterRoutes: 0, delivererRoutes: 0,
      packagesScheduled: 0, packagesUnscheduled: delivererResult.skipped.length,
      manifestsScheduled: 0, manifestsUnscheduled: 0,
      errors, durationMs: Date.now() - t0,
    };
  }

  // ── 5. Build optimizer request ────────────────────────────────────────────
  // Hub fields come directly from WorkerCandidate (projected by workerAssignment.service)
  const workerPayload: OptimizerWorker[] = allWorkers.map((w) => {
    const base: OptimizerWorker = {
      _id:    w._id.toString(),
      userId: w.userId.toString(),
      role:   w.role as "transporter" | "deliverer",
      // ✅ FIX (Problem 1 & 4): Pass the worker's pre-assigned vehicle to Python
      // This tells the Python optimizer that this worker already has a vehicle
      // and should be locked to it (no vehicle selection in GA)
      preferredVehicleId: w.vehicleId?.toString(),
    };
    if (w.transporterType === "hub_to_hub" && w.assignedLine?.length === 2) {
      base.transporterType = "hub_to_hub";
      base.assignedLine    = [
        w.assignedLine[0].toString(),
        w.assignedLine[1].toString(),
      ];
    } else if (w.transporterType === "hub_to_branch" && w.assignedBranches?.length) {
      base.transporterType  = "hub_to_branch";
      base.assignedBranches = w.assignedBranches.map((id) => id.toString());
    }
    return base;
  });

  const payload: OptimizerRequest = {
    branch: {
      _id:         branch._id.toString(),
      coordinates: branch.coordinates,
    },
    vehicles: vehicles.map((v) => ({
      _id:                v._id.toString(),
      type:               v.type,
      maxWeight:          v.maxWeight,
      maxVolume:          v.maxVolume,
      supportsFragile:    v.supportsFragile,
      registrationNumber: v.registrationNumber,
    })),
    workers:   workerPayload,
    manifests: optimizerManifests,
    packages: [
      ...transporterPkgs.map((p) => ({
        _id:                 p._id.toString(),
        weight:              p.weight,
        volume:              p.volume,
        isFragile:           p.isFragile,
        deliveryType:        p.deliveryType,
        deliveryPriority:    p.deliveryPriority,
        destinationBranchId: p.destinationBranchId?.toString(),
      })),
      ...delivererPkgs.map((p) => ({
        _id:              p._id.toString(),
        weight:           p.weight,
        volume:           p.volume,
        isFragile:        p.isFragile,
        deliveryType:     p.deliveryType,
        deliveryPriority: p.deliveryPriority,
        destination: p.destination
          ? {
              coordinates:    p.destination.coordinates,
              recipientName:  p.destination.recipientName,
              recipientPhone: p.destination.recipientPhone,
              address:        p.destination.address,
              city:           p.destination.city,
              state:          p.destination.state,
            }
          : undefined,
      })),
    ],
  };

  // ── 6. Call Python optimizer ──────────────────────────────────────────────
  let optimizerResult;
  try {
    optimizerResult = await callOptimizer(payload);
    console.log(
      `[orchestrator] [${branch.name}] Optimizer: ` +
      `${optimizerResult.routes.length} routes, ` +
      `unscheduled_pkg=${optimizerResult.unscheduled.length} ` +
      `unscheduled_man=${optimizerResult.unscheduledManifests.length} ` +
      `${optimizerResult.meta.durationMs}ms`,
    );
  } catch (err: any) {
    errors.push(`Optimizer failed: ${err.message}`);
    return {
      branchId: branch._id, branchName: branch.name,
      transporterRoutes: 0, delivererRoutes: 0,
      packagesScheduled: 0, packagesUnscheduled: allPackages.length,
      manifestsScheduled: 0, manifestsUnscheduled: optimizerManifests.length,
      errors, durationMs: Date.now() - t0,
    };
  }

  for (const u of optimizerResult.unscheduled) {
    errors.push(`Package ${u.packageId} unscheduled: ${u.reason}`);
  }
  for (const u of optimizerResult.unscheduledManifests) {
    errors.push(`Manifest ${u.manifestId} unscheduled: ${u.reason}`);
  }

  // ── 7. Persist routes ─────────────────────────────────────────────────────
  const scheduledStart = buildScheduledStart(scheduledDate);

  let transporterRoutes  = 0;
  let delivererRoutes    = 0;
  let packagesScheduled  = 0;
  let manifestsScheduled = 0;

  for (const route of optimizerResult.routes) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const routeId = await persistOptimizedRoute({
        route,
        branch,
        scheduledStart,
        session,
      });

      const workerId  = new mongoose.Types.ObjectId(route.workerId);
      const vehicleId = new mongoose.Types.ObjectId(route.vehicleId);
      const userId    = allWorkers.find((w) => w._id.toString() === route.workerId)?.userId;

      const isTransporterRoute =
        route.routeType === "hub_to_hub"    ||
        route.routeType === "hub_to_branch" ||
        route.routeType === "inter_branch";

      if (isTransporterRoute) {
        await markTransporterAssigned(workerId, routeId, vehicleId, session);
        transporterRoutes++;
      } else {
        await markDelivererAssigned(workerId, routeId, vehicleId, session);
        delivererRoutes++;
      }

      if (userId) {
        await markVehicleInUse(
          vehicleId,
          userId,
          branch._id,
          isTransporterRoute ? "transporter" : "deliverer",
          session,
        );
      }

      await session.commitTransaction();

      packagesScheduled  += route.packageIds.length;
      manifestsScheduled += route.manifestIds.length;

    } catch (err: any) {
      await session.abortTransaction();
      const msg = `Failed to persist route for vehicle ${route.vehicleId}: ${err.message}`;
      console.error(`[orchestrator] ${msg}`);
      errors.push(msg);
    } finally {
      session.endSession();
    }
  }

  return {
    branchId:             branch._id,
    branchName:           branch.name,
    transporterRoutes,
    delivererRoutes,
    packagesScheduled,
    packagesUnscheduled:  optimizerResult.unscheduled.length + delivererResult.skipped.length,
    manifestsScheduled,
    manifestsUnscheduled: optimizerResult.unscheduledManifests.length,
    errors,
    durationMs:           Date.now() - t0,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
//  PERSIST OPTIMIZED ROUTE
// ─────────────────────────────────────────────────────────────────────────────

interface PersistInput {
  route:          OptimizerRoute;
  branch:         BranchInfo;
  scheduledStart: Date;
  session:        mongoose.ClientSession;
}

async function persistOptimizedRoute(
  input: PersistInput,
): Promise<mongoose.Types.ObjectId> {
  const { route, branch, scheduledStart, session } = input;

  const routeNumber  = generateRouteNumber(scheduledStart);
  const vehicleId    = new mongoose.Types.ObjectId(route.vehicleId);
  const workerId     = new mongoose.Types.ObjectId(route.workerId);
  const packageIds   = route.packageIds.map((id) => new mongoose.Types.ObjectId(id));
  const manifestIds  = route.manifestIds.map((id) => new mongoose.Types.ObjectId(id));

  // ── Resolve real distance + time for hub_to_hub routes ─────────────────
  //  Python returns distanceKm=0 / distanceSource="n/a" for hub_to_hub because
  //  Haversine is too inaccurate for long Algerian hauls and the microservice's
  //  OSRM instance may not cover 2000 km intercity routes.
  //  We resolve it here with the full OSRM Route API, falling back to corrected
  //  Haversine, so the route document is created with correct values immediately.
  let finalDistanceKm:    number = route.distanceKm;
  let finalDistanceSource: string = route.distanceSource;
  let finalEstimatedTime: number = route.estimatedTimeMinutes;

  if (route.routeType === "hub_to_hub" && route.stops.length > 0) {
    const originCoords = branch.coordinates;            // [lng, lat]
    const destCoords   = route.stops[0].coordinates;   // [lng, lat]

    const resolved = await _resolveHubToHubDistance(originCoords, destCoords);
    finalDistanceKm     = resolved.distanceKm;
    finalDistanceSource = resolved.source;
    // Drive time + dwell at destination hub
    finalEstimatedTime  = resolved.driveMinutes + HUB_HUB_DWELL_MINUTES;
  }

  const scheduledEnd = new Date(
    scheduledStart.getTime() + finalEstimatedTime * 60_000,
  );

  // ── Determine stop dwell time by route type ──────────────────────────────
  const dwellMinutes =
    route.routeType === "hub_to_hub"    ? HUB_HUB_DWELL_MINUTES :
    route.routeType === "hub_to_branch" ? 20 :
    route.routeType === "inter_branch"  ? 20 : 8;

  // ── Determine stop action ────────────────────────────────────────────────
  const stopAction =
    route.routeType === "hub_to_hub"    ? "transfer" :
    route.routeType === "hub_to_branch" ? "transfer" :
    route.routeType === "inter_branch"  ? "transfer" : "delivery";

  // ── Map Python stops → RouteModel stop shape ─────────────────────────────
  const stops = route.stops.map((stop, idx) => ({
    order:    idx + 1,
    action:   stopAction,
    location: {
      type:        "Point" as const,
      coordinates: stop.coordinates,
    },
    address:             stop.address ?? "",
    branchId:            stop.destinationBranchId
      ? new mongoose.Types.ObjectId(stop.destinationBranchId)
      : undefined,
    // Raw packages (deliverer / legacy transporter)
    packageIds:          stop.packageIds.map((id) => new mongoose.Types.ObjectId(id)),
    // Manifest bags (hub routes)
    manifestIds:         stop.manifestIds.map((id) => new mongoose.Types.ObjectId(id)),
    status:              "pending" as const,
    stopDuration:        dwellMinutes,
    completedPackages:   [],
    failedPackages:      [],
    skippedPackages:     [],
    completedManifests:  [],
    discrepancyManifests:[],
  }));

  // ── Resolve destinationBranchId for the route document ───────────────────
  //  hub_to_hub   → the single destination hub (last stop's branchId)
  //  hub_to_branch→ undefined (multiple destinations)
  //  inter_branch → last stop's destinationBranchId (existing behaviour)
  //  local_delivery → undefined
  const routeDestinationBranchId =
    (route.routeType === "hub_to_hub" || route.routeType === "inter_branch")
      ? (route.stops[route.stops.length - 1]?.destinationBranchId
          ? new mongoose.Types.ObjectId(route.stops[route.stops.length - 1].destinationBranchId!)
          : undefined)
      : undefined;

  // ── Name ─────────────────────────────────────────────────────────────────
  const routeName =
    route.routeType === "hub_to_hub"    ? `Hub-to-Hub route ${routeNumber}` :
    route.routeType === "hub_to_branch" ? `Hub-to-Branch route ${routeNumber}` :
    route.routeType === "inter_branch"  ? `Inter-branch route ${routeNumber}` :
                                          `Delivery route ${routeNumber}`;

  // ── Create route document ─────────────────────────────────────────────────
  const [created] = await RouteModel.create(
    [
      {
        routeNumber,
        companyId:             branch.companyId,
        name:                  routeName,
        type:                  route.routeType,
        // hub_to_hub return routes originate at the partner hub, not branch._id.
        // Python sets route.originBranchId for all hub_to_hub routes so we
        // always persist the correct origin regardless of which leg this is.
        originBranchId:
          route.routeType === "hub_to_hub" && route.originBranchId
            ? new mongoose.Types.ObjectId(route.originBranchId)
            : branch._id,
        destinationBranchId:   routeDestinationBranchId,
        assignedVehicleId:     vehicleId,
        ...(route.routeType !== "local_delivery"
          ? { assignedTransporterId: workerId }
          : { assignedDelivererId:   workerId }),
        stops,
        distance:              parseFloat(finalDistanceKm.toFixed(2)),
        estimatedTime:         finalEstimatedTime,
        distanceSource:        finalDistanceSource,
        status:                "assigned",
        currentStopIndex:      0,
        completedStops:        0,
        failedStops:           0,
        skippedStops:          0,
        scheduledStart,
        scheduledEnd,
      },
    ],
    { session },
  );

  const routeOid = created._id as mongoose.Types.ObjectId;

  // ── Link packages to the new route ───────────────────────────────────────
  if (packageIds.length > 0) {
    await PackageModel.updateMany(
      { _id: { $in: packageIds } },
      { $set: { currentRouteId: routeOid } },
      { session },
    );
  }

  // ── Link manifests to the new route & populate their transport leg ────────
  //
  //  When Python assigns manifests to a route, the manifests already exist in
  //  MongoDB as "sealed" or "loaded".  We now:
  //    1. Set status → "loaded"  (if still "sealed"; already "loaded" is a no-op)
  //    2. Set transportLeg.transporterId, vehicleId, assignedAt
  //  The transporter controller handles the "in_transit" and "arrived"
  //  transitions later when the trip actually departs/arrives.

  if (manifestIds.length > 0) {
    await ManifestModel.updateMany(
      {
        _id:    { $in: manifestIds },
        status: { $in: ["sealed", "loaded"] },
      },
      {
        $set: {
          status:                      "loaded",
          "transportLeg.transporterId": workerId,
          "transportLeg.vehicleId":     vehicleId,
          "transportLeg.assignedAt":    new Date(),
        },
      },
      { session },
    );
  }

  return routeOid;
}


// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  HUB-TO-HUB DISTANCE RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the real road distance between two hub coordinates.
 *
 * Strategy:
 *   1. Try OSRM Route API  → accurate road distance and duration.
 *   2. Fall back to Haversine × HAVERSINE_ROAD_FACTOR  → corrected estimate.
 *
 * Returns { distanceKm, driveMinutes, source }.
 * Never throws — always returns a usable value.
 */
async function _resolveHubToHubDistance(
  origin: [number, number],
  dest:   [number, number],
): Promise<{ distanceKm: number; driveMinutes: number; source: "osrm" | "haversine" }> {
  // ── Try OSRM ──────────────────────────────────────────────────────────────
  try {
    const coordStr = `${origin[0]},${origin[1]};${dest[0]},${dest[1]}`;
    const url      = `${OSRM_URL}/route/v1/driving/${coordStr}?overview=false`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);

    const res  = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      if (data.code === "Ok" && data.routes?.[0]) {
        const distanceKm  = data.routes[0].distance / 1000;
        const driveMinutes = Math.round(data.routes[0].duration / 60);
        return { distanceKm, driveMinutes, source: "osrm" };
      }
    }
  } catch {
    // OSRM unavailable or timed out — fall through to Haversine
  }

  // ── Haversine fallback ────────────────────────────────────────────────────
  const straightLineKm = haversineKm(origin, dest);
  const correctedKm    = straightLineKm * HAVERSINE_ROAD_FACTOR;
  const driveMinutes   = Math.round((correctedKm / HUB_TO_HUB_SPEED_KMH) * 60);

  return { distanceKm: correctedKm, driveMinutes, source: "haversine" };
}


function buildScheduledStart(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(5, 0, 0, 0);   // 06:00 Algeria (UTC+1)
  return d;
}

let routeCounter = 0;
function generateRouteNumber(date: Date): string {
  routeCounter = (routeCounter + 1) % 10000;
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `R-${yyyymmdd}-${String(routeCounter).padStart(3, "0")}`;
}