// ─────────────────────────────────────────────────────────────────────────────
//  orchestrator.ts
//  Nightly route planning entry point.
//  Runs per-branch in parallel; each branch is a fully isolated transaction.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import BranchModel from "../models/branch.model";
import {
  BranchInfo, BranchPlanResult, DailyPlanResult, PackageCandidate,
  VehicleCandidate, WorkerCandidate,
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
import { packIntoFleet ,formatLoadSummary} from "./algorithms/binPacking.util";
import {
  buildTransporterRoute,
  persistTransporterRoute,
} from "./builders/transporterRouteBuilder";
import {
  buildDelivererRoute,
  persistDelivererRoute,
} from "./builders/delivererRouteBuilder";


// ─────────────────────────────────────────────────────────────────────────────
//  DAILY PLAN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plans routes for all active branches of all companies for a given date.
 *
 * @param scheduledDate  The date routes will run (typically tomorrow at 06:00)
 */
export async function runDailyRoutePlanning(
  scheduledDate: Date,
): Promise<DailyPlanResult> {
  const planStart = Date.now();

  // Fetch all active branches that have coordinates
  const branches = await BranchModel.find({
    status:               "active",
    "location.coordinates": { $exists: true, $ne: [] },
  })
    .select("_id name code wilaya location companyId")
    .lean() as any[];

  if (branches.length === 0) {
    console.warn("[orchestrator] No active branches with coordinates found.");
    return {
      date:               scheduledDate,
      totalRoutes:        0,
      totalScheduled:     0,
      totalUnscheduled:   0,
      branchResults:      [],
      totalDurationMs:    Date.now() - planStart,
    };
  }

  // Run all branches in parallel — failures in one do not affect others
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

    // Branch failed entirely — log and return an error result
    const branch = branches[i];
    console.error(
      `[orchestrator] Branch ${branch.name} (${branch._id}) failed:`,
      result.reason,
    );
    return {
      branchId:            branch._id,
      branchName:          branch.name,
      transporterRoutes:   0,
      delivererRoutes:     0,
      packagesScheduled:   0,
      packagesUnscheduled: 0,
      errors:              [(result.reason as Error)?.message ?? "Unknown error"],
      durationMs:          0,
    };
  });

  const totalRoutes      = branchResults.reduce((s, b) => s + b.transporterRoutes + b.delivererRoutes, 0);
  const totalScheduled   = branchResults.reduce((s, b) => s + b.packagesScheduled, 0);
  const totalUnscheduled = branchResults.reduce((s, b) => s + b.packagesUnscheduled, 0);

  const summary: DailyPlanResult = {
    date:             scheduledDate,
    totalRoutes,
    totalScheduled,
    totalUnscheduled,
    branchResults,
    totalDurationMs:  Date.now() - planStart,
  };

  console.log(
    `[orchestrator] Done — ${totalRoutes} routes, ` +
    `${totalScheduled} packages scheduled, ` +
    `${totalUnscheduled} unscheduled, ` +
    `${summary.totalDurationMs}ms`,
  );

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PER-BRANCH PLANNER
// ─────────────────────────────────────────────────────────────────────────────

async function planBranch(
  branch:        BranchInfo,
  scheduledDate: Date,
): Promise<BranchPlanResult> {
  const t0     = Date.now();
  const errors: string[] = [];

  let transporterRoutes  = 0;
  let delivererRoutes    = 0;
  let packagesScheduled  = 0;
  let packagesUnscheduled = 0;

  // ── Fetch everything in parallel ──────────────────────────────────────────
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

  // Log packages skipped due to missing coordinates
  for (const s of delivererResult.skipped) {
    errors.push(`Package ${s._id}: ${s.reason}`);
    packagesUnscheduled++;
  }

  const delivererPkgs = delivererResult.candidates;

  // ── TRANSPORTER PASS ──────────────────────────────────────────────────────
  if (transporterPkgs.length > 0 && transporters.length > 0 && vehicles.length > 0) {
    const result = await planWorkerPass({
      packages:      transporterPkgs,
      workers:       transporters,
      vehicles,
      branch,
      scheduledDate,
      workerType:    "transporter",
    });

    transporterRoutes   += result.routesCreated;
    packagesScheduled   += result.scheduled;
    packagesUnscheduled += result.unscheduled;
    errors.push(...result.errors);
  } else {
    packagesUnscheduled += transporterPkgs.length;
    if (transporterPkgs.length > 0) {
      errors.push(
        `${transporterPkgs.length} transporter package(s) unscheduled — ` +
        `${transporters.length} transporter(s), ${vehicles.length} vehicle(s) available`,
      );
    }
  }

  // ── DELIVERER PASS ────────────────────────────────────────────────────────
  if (delivererPkgs.length > 0 && deliverers.length > 0 && vehicles.length > 0) {
    const result = await planWorkerPass({
      packages:      delivererPkgs,
      workers:       deliverers,
      vehicles,
      branch,
      scheduledDate,
      workerType:    "deliverer",
    });

    delivererRoutes     += result.routesCreated;
    packagesScheduled   += result.scheduled;
    packagesUnscheduled += result.unscheduled;
    errors.push(...result.errors);
  } else {
    packagesUnscheduled += delivererPkgs.length;
    if (delivererPkgs.length > 0) {
      errors.push(
        `${delivererPkgs.length} deliverer package(s) unscheduled — ` +
        `${deliverers.length} deliverer(s), ${vehicles.length} vehicle(s) available`,
      );
    }
  }

  return {
    branchId:            branch._id,
    branchName:          branch.name,
    transporterRoutes,
    delivererRoutes,
    packagesScheduled,
    packagesUnscheduled,
    errors,
    durationMs:          Date.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  GENERIC WORKER PASS
//  Shared logic for both transporter and deliverer rounds:
//    while (packages remain AND workers remain AND vehicles remain):
//      1. pack as many packages as possible into one vehicle
//      2. build route
//      3. persist in a transaction
//      4. pop worker + vehicle, remove loaded packages
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerPassInput {
  packages:      PackageCandidate[];
  workers:       WorkerCandidate[];
  vehicles:      VehicleCandidate[];
  branch:        BranchInfo;
  scheduledDate: Date;
  workerType:    "transporter" | "deliverer";
}

interface WorkerPassResult {
  routesCreated: number;
  scheduled:     number;
  unscheduled:   number;
  errors:        string[];
}

async function planWorkerPass(
  input: WorkerPassInput,
): Promise<WorkerPassResult> {
  let { packages, workers, vehicles } = input;
  const { branch, scheduledDate, workerType } = input;

  const errors:        string[] = [];
  let   routesCreated  = 0;
  let   scheduled      = 0;

  // Mutable copies — we pop from them as we assign
  const availableWorkers  = [...workers];
  const availableVehicles = [...vehicles];
  let   remainingPackages = [...packages];

  while (
    remainingPackages.length > 0 &&
    availableWorkers.length  > 0 &&
    availableVehicles.length > 0
  ) {
    const worker  = availableWorkers[0];
    const vehicle = availableVehicles[0];

    // Bin-pack remaining packages into this vehicle
    const fleetResult = packIntoFleet(remainingPackages, [vehicle]);
    const assignment  = fleetResult.assignments[0];

    if (!assignment || assignment.load.loaded.length === 0) {
      // This vehicle couldn't take any package (fragile mismatch or weight)
      errors.push(
        `Vehicle ${vehicle.registrationNumber} skipped — no compatible packages`,
      );
      availableVehicles.shift();
      continue;
    }

    const { load } = assignment;

    console.log(
      `[orchestrator] [${branch.name}] [${workerType}] ` +
      formatLoadSummary(load, vehicle),
    );

    // Build route
    let routeId: mongoose.Types.ObjectId | null = null;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let planned = null;

      if (workerType === "transporter") {
        planned = await buildTransporterRoute({
          packages:       load.loaded,
          vehicle,
          worker,
          originBranch:   branch,
          totalWeight:    load.totalWeight,
          totalVolume:    load.totalVolume,
          scheduledStart: buildScheduledStart(scheduledDate),
        });
      } else {
        planned = await buildDelivererRoute({
          packages:       load.loaded,
          vehicle,
          worker,
          originBranch:   branch,
          totalWeight:    load.totalWeight,
          totalVolume:    load.totalVolume,
          scheduledStart: buildScheduledStart(scheduledDate),
        });
      }

      if (!planned) {
        throw new Error(
          `Builder returned null for ${workerType} ${worker._id} — ` +
          "possible missing branch coordinates",
        );
      }

      if (workerType === "transporter") {
        routeId = await persistTransporterRoute(planned, session);
        await markTransporterAssigned(worker._id, routeId, vehicle._id, session);
      } else {
        routeId = await persistDelivererRoute(planned, session);
        await markDelivererAssigned(worker._id, routeId, vehicle._id, session);
      }

      await markVehicleInUse(
        vehicle._id,
        worker.userId,
        branch._id,
        workerType,
        session,
      );

      await session.commitTransaction();
      session.endSession();

      routesCreated++;
      scheduled += load.loaded.length;

      // Remove used worker and vehicle from available pools
      availableWorkers.shift();
      availableVehicles.shift();

      // Remove loaded packages from remaining
      const loadedIds = new Set(load.loaded.map((p) => p._id.toString()));
      remainingPackages = remainingPackages.filter(
        (p) => !loadedIds.has(p._id.toString()),
      );
    } catch (err: any) {
      await session.abortTransaction();
      session.endSession();

      const msg = `Failed to create ${workerType} route for worker ${worker._id}: ${err.message}`;
      console.error(`[orchestrator] ${msg}`);
      errors.push(msg);

      // Skip this worker and try the next one with the same remaining packages
      availableWorkers.shift();
    }
  }

  const unscheduled = remainingPackages.length;

  if (unscheduled > 0) {
    errors.push(
      `${unscheduled} ${workerType} package(s) remain unscheduled ` +
      `(${availableWorkers.length} worker(s) left, ${availableVehicles.length} vehicle(s) left)`,
    );
  }

  return { routesCreated, scheduled, unscheduled, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routes start at 06:00 Algeria local time (UTC+1 = 05:00 UTC).
 * Accepts any Date and returns a new Date set to 06:00 Algeria on that day.
 */
function buildScheduledStart(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(5, 0, 0, 0); // 05:00 UTC = 06:00 Algeria (UTC+1)
  return d;
}