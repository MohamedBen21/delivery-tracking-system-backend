// ─────────────────────────────────────────────────────────────────────────────
//  vehicleAssignmentService.ts
//  Fetches available vehicles at a branch and provides assignment helpers.
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
//    • assignedUserId is null     (not already assigned to a worker)
//    • companyId matches
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableVehicles(
  branchId:  mongoose.Types.ObjectId,
  companyId: mongoose.Types.ObjectId,
): Promise<VehicleCandidate[]> {
  const now              = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Replicate the documentStatus virtual in the query:
  // documents must exist, not be expired, and have the three required fields.
  const docs = await VehicleModel.find({
    companyId,
    currentBranchId: branchId,
    status:          "available",
    assignedUserId:  null,

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
      "_id type registrationNumber maxWeight maxVolume supportsFragile",
    )
    .lean();

  return (docs as any[]).map((d) => ({
    _id:                d._id,
    type:               d.type as VehicleType,
    maxWeight:          d.maxWeight,
    maxVolume:          d.maxVolume,
    supportsFragile:    d.supportsFragile ?? true,
    registrationNumber: d.registrationNumber,
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