import mongoose from "mongoose";
import BranchModel from "../models/branch.model";
import {
  BranchInfo, BranchPlanResult, DailyPlanResult,
} from "./types.util";
import {
  getTransporterCandidates,
  getDelivererCandidates,
} from "./services/packageCandidate.service";
import {
  getAvailableVehicles,
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
  OptimizerRequest,
  OptimizerRoute,
} from "./services/optimizerClient";
import { persistTransporterRoute } from "./builders/transporterRouteBuilder";
import { persistDelivererRoute }   from "./builders/delivererRouteBuilder";
import RouteModel from "../models/route.model";
import PackageModel from "../models/package.model";

// ─────────────────────────────────────────────────────────────────────────────
//  DAILY PLAN ENTRY POINT  (unchanged signature)
// ─────────────────────────────────────────────────────────────────────────────

export async function runDailyRoutePlanning(
  scheduledDate: Date,
): Promise<DailyPlanResult> {
  const planStart = Date.now();

  const branches = await BranchModel.find({
    status: "active",
    "location.coordinates": { $exists: true, $ne: [] },
  })
    .select("_id name code wilaya location companyId")
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
//  PER-BRANCH PLANNER  (now calls Python)
// ─────────────────────────────────────────────────────────────────────────────

async function planBranch(
  branch: BranchInfo,
  scheduledDate: Date,
): Promise<BranchPlanResult> {
  const t0     = Date.now();
  const errors: string[] = [];

  // ── 1. Fetch data (Node.js responsibility) ────────────────────────────────
  const [
    transporterPkgs,
    delivererResult,
    vehicles,
    transporters,
    deliverers,
  ] = await Promise.all([
    getTransporterCandidates(branch._id, branch.companyId),
    getDelivererCandidates(branch._id, branch.companyId),
    getAvailableVehicles(branch._id, branch.companyId),
    getAvailableTransporters(branch._id, branch.companyId, scheduledDate),
    getAvailableDeliverers(branch._id, branch.companyId, scheduledDate),
  ]);

  for (const s of delivererResult.skipped) {
    errors.push(`Package ${s._id}: ${s.reason}`);
  }

  const delivererPkgs = delivererResult.candidates;
  const allPackages   = [...transporterPkgs, ...delivererPkgs];

  if (allPackages.length === 0) {
    return {
      branchId: branch._id, branchName: branch.name,
      transporterRoutes: 0, delivererRoutes: 0,
      packagesScheduled: 0, packagesUnscheduled: delivererResult.skipped.length,
      errors, durationMs: Date.now() - t0,
    };
  }

  // ── 2. Build optimizer request ────────────────────────────────────────────
  const allWorkers = [...transporters, ...deliverers];

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
    workers: allWorkers.map((w) => ({
      _id:    w._id.toString(),
      userId: w.userId.toString(),
      role:   w.role,
    })),
    packages: [
      ...transporterPkgs.map((p) => ({
        _id:                  p._id.toString(),
        weight:               p.weight,
        volume:               p.volume,
        isFragile:            p.isFragile,
        deliveryType:         p.deliveryType,
        deliveryPriority:     p.deliveryPriority,
        destinationBranchId:  p.destinationBranchId?.toString(),
      })),
      ...delivererPkgs.map((p) => ({
        _id:             p._id.toString(),
        weight:          p.weight,
        volume:          p.volume,
        isFragile:       p.isFragile,
        deliveryType:    p.deliveryType,
        deliveryPriority:p.deliveryPriority,
        destination:     p.destination
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

  // ── 3. Call Python optimizer ──────────────────────────────────────────────
  let optimizerResult;
  try {
    optimizerResult = await callOptimizer(payload);
    console.log(
      `[orchestrator] [${branch.name}] Optimizer: ` +
      `${optimizerResult.routes.length} routes, ` +
      `${optimizerResult.unscheduled.length} unscheduled, ` +
      `${optimizerResult.meta.durationMs}ms (optimizer)`,
    );
  } catch (err: any) {
    errors.push(`Optimizer failed: ${err.message}`);
    return {
      branchId: branch._id, branchName: branch.name,
      transporterRoutes: 0, delivererRoutes: 0,
      packagesScheduled: 0, packagesUnscheduled: allPackages.length,
      errors, durationMs: Date.now() - t0,
    };
  }

  // Record unscheduled packages
  for (const u of optimizerResult.unscheduled) {
    errors.push(`Package ${u.packageId} unscheduled: ${u.reason}`);
  }

  // ── 4. Persist routes (Node.js responsibility — keeps transactions here) ───
  const scheduledStart = buildScheduledStart(scheduledDate);

  let transporterRoutes  = 0;
  let delivererRoutes    = 0;
  let packagesScheduled  = 0;

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

      // Mark worker assigned
      const workerId  = new mongoose.Types.ObjectId(route.workerId);
      const vehicleId = new mongoose.Types.ObjectId(route.vehicleId);
      const userId    = allWorkers.find((w) => w._id.toString() === route.workerId)?.userId;

      if (route.routeType === "inter_branch") {
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
          route.routeType === "inter_branch" ? "transporter" : "deliverer",
          session,
        );
      }

      await session.commitTransaction();
      packagesScheduled += route.packageIds.length;
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
    branchId:            branch._id,
    branchName:          branch.name,
    transporterRoutes,
    delivererRoutes,
    packagesScheduled,
    packagesUnscheduled: optimizerResult.unscheduled.length + delivererResult.skipped.length,
    errors,
    durationMs:          Date.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PERSIST OPTIMIZED ROUTE
//  Converts the Python optimizer output into a RouteModel document.
//  This replaces buildTransporterRoute + buildDelivererRoute for the
//  route construction step (the builders are only used for persistence shape).
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

  const scheduledEnd = new Date(
    scheduledStart.getTime() + route.estimatedTimeMinutes * 60_000,
  );

  // Map Python stops → RouteModel stop shape
  const stops = route.stops.map((stop, idx) => ({
    order:   idx + 1,
    action:  route.routeType === "inter_branch" ? "transfer" : "delivery",
    location: {
      type:        "Point" as const,
      coordinates: stop.coordinates,
    },
    address:           stop.address ?? "",
    branchId:          stop.destinationBranchId
      ? new mongoose.Types.ObjectId(stop.destinationBranchId)
      : undefined,
    packageIds:        stop.packageIds.map((id) => new mongoose.Types.ObjectId(id)),
    status:            "pending" as const,
    stopDuration:      route.routeType === "inter_branch" ? 20 : 8,
    completedPackages: [],
    failedPackages:    [],
    skippedPackages:   [],
  }));

  const [created] = await RouteModel.create(
    [
      {
        routeNumber,
        companyId:             branch.companyId,
        name:                  `${route.routeType === "inter_branch" ? "Inter-branch" : "Delivery"} route ${routeNumber}`,
        type:                  route.routeType,
        originBranchId:        branch._id,
        destinationBranchId:   route.routeType === "inter_branch"
          ? new mongoose.Types.ObjectId(route.stops[route.stops.length - 1]?.destinationBranchId ?? "")
          : undefined,
        assignedVehicleId:     vehicleId,
        ...(route.routeType === "inter_branch"
          ? { assignedTransporterId: workerId }
          : { assignedDelivererId:   workerId }),
        stops,
        distance:              route.distanceKm,
        estimatedTime:         route.estimatedTimeMinutes,
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

  await PackageModel.updateMany(
    { _id: { $in: packageIds } },
    { $set: { currentRouteId: created._id } },
    { session },
  );

  return created._id as mongoose.Types.ObjectId;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function buildScheduledStart(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(5, 0, 0, 0); // 06:00 Algeria (UTC+1)
  return d;
}

let routeCounter = 0;
function generateRouteNumber(date: Date): string {
  routeCounter = (routeCounter + 1) % 10000;
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `R-${yyyymmdd}-${String(routeCounter).padStart(3, "0")}`;
}



// ─────────────────────────────────────────────────────────────────────────────
//  Updated orchestrator: fetches data → calls Python optimizer → persists.
//
//  What changed vs the original orchestrator.ts:
//    • NO more packIntoFleet / binPacking calls
//    • NO more buildTransporterRoute / buildDelivererRoute calls
//    • One call to callOptimizer() replaces the entire planning loop
//    • Persistence logic unchanged — same RouteModel, same transactions
// ─────────────────────────────────────────────────────────────────────────────