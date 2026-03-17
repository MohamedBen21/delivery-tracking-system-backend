// ─────────────────────────────────────────────────────────────────────────────
//  workerAssignmentService.ts
//  Fetches workers who are available to be assigned a route today,
//  and provides post-assignment update helpers.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import DelivererModel  from "../../models/deliverer.model";
import TransporterModel from "../../models/transporter.model";
import RouteModel from "../../models/route.model";
import { WorkerCandidate } from "../types.util";

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
 * Used to exclude workers who are already assigned today.
 */
async function getAlreadyAssignedWorkerIds(
  date:     Date,
  field:    "assignedTransporterId" | "assignedDelivererId",
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
//    • currentBranchId = branch  (physically at this branch)
//    • no non-cancelled/completed route today
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableTransporters(
  branchId:   mongoose.Types.ObjectId,
  companyId:  mongoose.Types.ObjectId,
  scheduleDate: Date,
): Promise<WorkerCandidate[]> {
  const alreadyAssigned = await getAlreadyAssignedWorkerIds(
    scheduleDate,
    "assignedTransporterId",
    companyId,
  );

  const docs = await TransporterModel.find({
    companyId,
    currentBranchId:      branchId,
    availabilityStatus:   "available",
    verificationStatus:   "verified",
    isActive:             true,
    isSuspended:          false,
  })
    .select("_id userId currentVehicleId")
    .lean();

  return (docs as any[])
    .filter((d) => !alreadyAssigned.has(d._id.toString()))
    .map((d) => ({
      _id:       d._id,
      userId:    d.userId,
      role:      "transporter" as const,
      vehicleId: d.currentVehicleId ?? undefined,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  DELIVERERS
//
//  Available when:
//    • availabilityStatus = "available"
//    • verificationStatus = "verified"
//    • isActive = true, isSuspended = false
//    • branchId = branch  (note: deliverer uses branchId, not currentBranchId)
//    • no non-cancelled/completed route today
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
  })
    .select("_id userId currentVehicleId")
    .lean();

  return (docs as any[])
    .filter((d) => !alreadyAssigned.has(d._id.toString()))
    .map((d) => ({
      _id:       d._id,
      userId:    d.userId,
      role:      "deliverer" as const,
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
        // "assigned" not "on_route" — the route is planned but not started yet
        // availabilityStatus flips to on_route when transporter taps "Start"
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