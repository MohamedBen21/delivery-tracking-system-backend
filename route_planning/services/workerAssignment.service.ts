// ─────────────────────────────────────────────────────────────────────────────
//  workerAssignmentService.ts
//  Fetches workers who are available to be assigned a route today,
//  and provides post-assignment update helpers.
//
//  Hub model change
//  ────────────────
//  getAvailableTransporters now includes transporterType, assignedLine,
//  and assignedBranches in its projection so the orchestrator can build the
//  full OptimizerWorker payload without a second TransporterModel query.
//
//  Fix (Problem 2 & 4):
//  ─────────────────────
//  Removed `currentVehicleId: null` filter from BOTH getAvailableTransporters
//  and getAvailableDeliverers.  Workers with a pre-assigned vehicle
//  (currentVehicleId set) are still available for route assignment today —
//  the pre-assigned vehicle IS their vehicle for the day.
//
//  Workers are matched to their pre-assigned vehicle by vehicleId in the CVRP.
//  If a worker has vehicleId set, the Python optimizer will prefer to assign
//  that vehicle to them (passed as preferredVehicleId in OptimizerWorker).
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import DelivererModel   from "../../models/deliverer.model";
import TransporterModel from "../../models/transporter.model";
import RouteModel       from "../../models/route.model";
import { WorkerCandidate, TransporterType } from "../types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Start and end of a calendar day in UTC */
function dayBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Returns the set of worker doc _ids (Transporter or Deliverer) that already
 * have a non-cancelled/non-completed route scheduled on `date`.
 */
async function getAlreadyAssignedWorkerIds(
  date:      Date,
  field:     "assignedTransporterId" | "assignedDelivererId",
  companyId: mongoose.Types.ObjectId,
): Promise<Set<string>> {
  const { start, end } = dayBounds(date);

  const routes = await RouteModel.find({
    companyId,
    [field]:        { $exists: true, $ne: null },
    scheduledStart: { $gte: start, $lte: end },
    status:         { $nin: ["cancelled", "completed"] },
  })
    .select(field)
    .lean();

  return new Set(
    (routes as any[]).map((r) => r[field]?.toString()).filter(Boolean),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSPORTERS
//
//  Available when:
//    • availabilityStatus = "available"
//    • verificationStatus = "verified"
//    • isActive = true, isSuspended = false
//    • currentBranchId = branch  (physically at this branch today)
//    • no non-cancelled/completed route already scheduled today
//
//  Hub fields included in projection:
//    • transporterType    — "hub_to_hub" | "hub_to_branch" | null
//    • assignedLine       — [hubAId, hubBId] for hub_to_hub workers
//    • assignedBranches   — [...branchIds] for hub_to_branch workers
//
//  NOTE: `currentVehicleId: null` filter REMOVED (Fix Problem 4).
//  Transporters with a pre-assigned vehicle (currentVehicleId set) are
//  still available.  vehicleId is included in the projection so the
//  orchestrator passes it to Python as preferredVehicleId.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableTransporters(
  branchId:     mongoose.Types.ObjectId,
  companyId:    mongoose.Types.ObjectId,
  scheduleDate: Date,
): Promise<WorkerCandidate[]> {
  const alreadyAssigned = await getAlreadyAssignedWorkerIds(
    scheduleDate,
    "assignedTransporterId",
    companyId,
  );

  const docs = await TransporterModel.find({
    companyId,
    currentBranchId:    branchId,
    availabilityStatus: "available",
    verificationStatus: "verified",
    isActive:           true,
    isSuspended:        false,
    // NOTE: `currentVehicleId: null` removed — workers with pre-assigned vehicles are valid
  })
    .select(
      "_id userId currentVehicleId " +
      "transporterType assignedLine assignedBranches",
    )
    .lean();

  return (docs as any[])
    .filter((d) => !alreadyAssigned.has(d._id.toString()))
    .map((d) => {
      const candidate: WorkerCandidate = {
        _id:       d._id,
        userId:    d.userId,
        role:      "transporter" as const,
        // Always include vehicleId if set — CVRP uses this to lock in the pairing
        vehicleId: d.currentVehicleId ?? undefined,
      };

      // Attach hub fields when present — the orchestrator forwards these
      // directly to the Python optimizer without any extra DB lookup.
      if (d.transporterType) {
        candidate.transporterType = d.transporterType as TransporterType;
      }
      if (
        d.transporterType === "hub_to_hub" &&
        Array.isArray(d.assignedLine) &&
        d.assignedLine.length === 2
      ) {
        candidate.assignedLine = [d.assignedLine[0], d.assignedLine[1]];
      }
      if (
        d.transporterType === "hub_to_branch" &&
        Array.isArray(d.assignedBranches) &&
        d.assignedBranches.length > 0
      ) {
        candidate.assignedBranches = d.assignedBranches;
      }

      return candidate;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  DELIVERERS
//
//  Available when:
//    • availabilityStatus = "available"
//    • verificationStatus = "verified"
//    • isActive = true, isSuspended = false
//    • branchId = branch  (deliverer uses branchId, not currentBranchId)
//    • no non-cancelled/completed route today
//
//  NOTE: `currentVehicleId: null` filter REMOVED (Fix Problem 4).
//  Deliverers with a pre-assigned vehicle are still available for today's routes.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableDeliverers(
  branchId:     mongoose.Types.ObjectId,
  companyId:    mongoose.Types.ObjectId,
  scheduleDate: Date,
): Promise<WorkerCandidate[]> {
  const alreadyAssigned = await getAlreadyAssignedWorkerIds(
    scheduleDate,
    "assignedDelivererId",
    companyId,
  );

  const docs = await DelivererModel.find({
    companyId,
    branchId,
    availabilityStatus: "available",
    verificationStatus: "verified",
    isActive:           true,
    isSuspended:        false,
    // NOTE: `currentVehicleId: null` removed — workers with pre-assigned vehicles are valid
  })
    .select("_id userId currentVehicleId")
    .lean();

  return (docs as any[])
    .filter((d) => !alreadyAssigned.has(d._id.toString()))
    .map((d) => ({
      _id:       d._id,
      userId:    d.userId,
      role:      "deliverer" as const,
      // Always include vehicleId if set — CVRP uses this to lock in the pairing
      vehicleId: d.currentVehicleId ?? undefined,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST-ASSIGNMENT UPDATES  (called by orchestrator after route is saved)
// ─────────────────────────────────────────────────────────────────────────────

export async function markTransporterAssigned(
  transporterId: mongoose.Types.ObjectId,
  routeId:       mongoose.Types.ObjectId,
  vehicleId:     mongoose.Types.ObjectId,
  session:       mongoose.ClientSession,
): Promise<void> {
  await TransporterModel.findByIdAndUpdate(
    transporterId,
    {
      $set: {
        // availabilityStatus stays "available" until the transporter taps
        // "Start Trip" — the controller flips it to "on_route" at that point.
        currentRouteId:   routeId,
        currentVehicleId: vehicleId,
        lastActiveAt:     new Date(),
      },
    },
    { session },
  );
}

export async function markDelivererAssigned(
  delivererId: mongoose.Types.ObjectId,
  routeId:     mongoose.Types.ObjectId,
  vehicleId:   mongoose.Types.ObjectId,
  session:     mongoose.ClientSession,
): Promise<void> {
  await DelivererModel.findByIdAndUpdate(
    delivererId,
    {
      $set: {
        currentRouteId:   routeId,
        currentVehicleId: vehicleId,
        lastActiveAt:     new Date(),
      },
    },
    { session },
  );
}