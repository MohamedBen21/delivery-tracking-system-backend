// ─────────────────────────────────────────────────────────────────────────────
//  vehicleAssignmentService.ts
//  Fetches available vehicles at a branch and provides assignment helpers.
//
//  Fix (Problem 1 & 4):
//    Removed `assignedUserId: null` from the query filter.
//    Vehicles with a pre-assigned userId (permanently assigned to workers)
//    are valid candidates for CVRP route assignment — they are "available"
//    for use even though they already have an assignedUserId.
//    The CVRP prioritises keeping existing vehicle-worker pairings via
//    the preferredVehicleId field on OptimizerWorker (handled in the pipeline).
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import VehicleModel from "../../models/vehicle.model";
import { VehicleCandidate, VehicleType, VEHICLE_TYPE_ORDER } from "../types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  FETCH
//
//  A vehicle is available for route assignment when:
//    • status = "available"       (not in_use, maintenance, etc.)
//    • currentBranchId = branch   (physically at this branch)
//    • documentStatus = "valid"   (checked via virtual — but virtuals don't
//                                  work in .lean(); we replicate the logic below)
//    • companyId matches
//
//  NOTE: assignedUserId is intentionally NOT filtered here.
//  Vehicles permanently assigned to workers (assignedUserId set) are still
//  physically available for today's routes.  The CVRP respects existing
//  pairings by matching them via workerCandidate.vehicleId.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableVehicles(
  branchId:  mongoose.Types.ObjectId,
  companyId: mongoose.Types.ObjectId,
): Promise<VehicleCandidate[]> {
  const now              = new Date();

  // Replicate the documentStatus virtual in the query:
  // documents must exist, not be expired, and have the three required fields.
  const docs = await VehicleModel.find({
    companyId,
    currentBranchId: branchId,
    status:          "available",
    // NOTE: `assignedUserId: null` removed — pre-assigned vehicles are valid candidates

    // Must have all three required document fields
    "documents.registrationCard":    { $exists: true, $ne: null },
    "documents.insurance":           { $exists: true, $ne: null },
    "documents.technicalInspection": { $exists: true, $ne: null },

    // Insurance must not be expired
    $or: [
      { "documents.insuranceExpiry":   { $exists: false } },
      { "documents.insuranceExpiry":   { $gt: now } },
    ],

    // Technical inspection must not be expired
    $and: [
      {
        $or: [
          { "documents.inspectionExpiry": { $exists: false } },
          { "documents.inspectionExpiry": { $gt: now } },
        ],
      },
    ],
  })
    .select(
      "_id type registrationNumber maxWeight maxVolume supportsFragile assignedUserId",
    )
    .lean();

  return (docs as any[]).map((d) => ({
    _id:                d._id,
    type:               d.type as VehicleType,
    maxWeight:          d.maxWeight,
    maxVolume:          d.maxVolume,
    supportsFragile:    d.supportsFragile ?? true,
    registrationNumber: d.registrationNumber,
    // Expose the pre-assigned userId so the orchestrator can match
    // vehicles back to their permanently-assigned workers.
    assignedUserId:     d.assignedUserId ?? undefined,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MARK IN USE  (called by orchestrator after a route is saved)
// ─────────────────────────────────────────────────────────────────────────────

export async function markVehicleInUse(
  vehicleId: mongoose.Types.ObjectId,
  userId:    mongoose.Types.ObjectId,
  branchId:  mongoose.Types.ObjectId,
  userRole:  "transporter" | "deliverer",
  session:   mongoose.ClientSession,
): Promise<void> {
  await VehicleModel.findByIdAndUpdate(
    vehicleId,
    {
      $set: {
        status:           "in_use",
        assignedUserId:   userId,
        assignedUserRole: userRole,
        currentBranchId:  branchId,
      },
    },
    { session },
  );
}