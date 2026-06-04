// ─────────────────────────────────────────────────────────────────────────────
//  workerAssignmentService.ts
//  Fetches workers who are available to be assigned a route today,
//  and provides post-assignment update helpers.
//
//  Hub model change
//  ────────────────
//  getAvailableTransporters includes transporterType, assignedLine,
//  and assignedBranches in its projection so the orchestrator can build the
//  full OptimizerWorker payload without a second TransporterModel query.
//
//  Fix (Problems 1 & 4):
//  ──────────────────────
//  Workers are only valid CVRP candidates when they HAVE a vehicle assigned
//  to them (currentVehicleId is set).  A worker without a vehicle cannot
//  be sent on a route.
//
//  Correct flow:
//    1. Manager assigns vehicle to worker → vehicle.status = "in_use",
//       worker.currentVehicleId = vehicleId.  Worker stays "available".
//    2. CVRP fetches workers with availabilityStatus="available" AND
//       currentVehicleId set → ready to receive packages/manifests.
//    3. Orchestrator sends each worker + their pre-assigned vehicle to Python.
//    4. Python assigns packages/manifests to that fixed worker-vehicle pair.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import DelivererModel   from "../../models/deliverer.model";
import TransporterModel from "../../models/transporter.model";
import RouteModel       from "../../models/route.model";
import { WorkerCandidate, TransporterType } from "../types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function dayBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

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
//  Valid CVRP candidate when:
//    • availabilityStatus = "available"  — no active route right now
//    • verificationStatus = "verified"
//    • isActive = true, isSuspended = false
//    • currentBranchId = branchId        — physically at this branch
//    • currentVehicleId IS SET           — manager has assigned a vehicle
//    • no route already scheduled today
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
    currentVehicleId:   { $exists: true, $ne: null },  // must have a vehicle
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
        vehicleId: d.currentVehicleId,   // always present — guaranteed by query
      };

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
//  Valid CVRP candidate when:
//    • availabilityStatus = "available"  — no active route right now
//    • verificationStatus = "verified"
//    • isActive = true, isSuspended = false
//    • branchId = branchId               — assigned to this branch
//    • currentVehicleId IS SET           — manager has assigned a vehicle
//    • no route already scheduled today
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
    currentVehicleId:   { $exists: true, $ne: null },  // must have a vehicle
  })
    .select("_id userId currentVehicleId")
    .lean();

  return (docs as any[])
    .filter((d) => !alreadyAssigned.has(d._id.toString()))
    .map((d) => ({
      _id:       d._id,
      userId:    d.userId,
      role:      "deliverer" as const,
      vehicleId: d.currentVehicleId,   // always present — guaranteed by query
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