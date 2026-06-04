// ─────────────────────────────────────────────────────────────────────────────
//  vehicleAssignmentService.ts
//  Fetches available vehicles at a branch and provides assignment helpers.
//
//  Fix (Problems 1 & 4):
//  ──────────────────────
//  The CVRP flow no longer uses getAvailableVehicles() to build a pool of
//  vehicles and then match workers to them.  Instead:
//
//    • Workers are fetched with currentVehicleId already set (by the manager).
//    • The orchestrator resolves each worker's vehicle directly from
//      worker.vehicleId via getVehiclesByIds().
//    • Python receives each worker paired with their specific vehicle —
//      it only assigns packages/manifests, not vehicles.
//
//  getAvailableVehicles() is kept for other use-cases (e.g. admin dashboards,
//  manual assignment UIs) but is no longer called by the CVRP orchestrator.
//
//  getVehiclesByIds() is the new function used by the orchestrator to resolve
//  the pre-assigned vehicles from a list of IDs collected from workers.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import VehicleModel from "../../models/vehicle.model";
import { VehicleCandidate, VehicleType } from "../types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  FETCH BY IDs  (used by orchestrator — replaces getAvailableVehicles for CVRP)
//
//  Resolves the actual vehicle documents for a list of vehicle IDs collected
//  from workers' currentVehicleId fields.  The manager has already assigned
//  these vehicles; we just need their specs (maxWeight, maxVolume, etc.)
//  so Python can check capacity when assigning packages/manifests.
//
//  No status filter — the vehicle is legitimately "in_use" because it is
//  permanently assigned to a worker.  What matters is the worker's
//  availabilityStatus = "available" (checked in workerAssignment.service.ts).
// ─────────────────────────────────────────────────────────────────────────────

export async function getVehiclesByIds(
  vehicleIds: mongoose.Types.ObjectId[],
  companyId:  mongoose.Types.ObjectId,
): Promise<VehicleCandidate[]> {
  if (vehicleIds.length === 0) return [];

  const docs = await VehicleModel.find({
    _id:       { $in: vehicleIds },
    companyId,
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
//  FETCH AVAILABLE  (kept for admin / dashboard use — NOT used by CVRP)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableVehicles(
  branchId:  mongoose.Types.ObjectId,
  companyId: mongoose.Types.ObjectId,
): Promise<VehicleCandidate[]> {
  const now = new Date();

  const docs = await VehicleModel.find({
    companyId,
    currentBranchId: branchId,
    status:          "available",
    assignedUserId:  null,

    "documents.registrationCard":    { $exists: true, $ne: null },
    "documents.insurance":           { $exists: true, $ne: null },
    "documents.technicalInspection": { $exists: true, $ne: null },

    $or: [
      { "documents.insuranceExpiry":  { $exists: false } },
      { "documents.insuranceExpiry":  { $gt: now } },
    ],

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
//  MARK IN USE  (called by orchestrator when route actually starts)
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