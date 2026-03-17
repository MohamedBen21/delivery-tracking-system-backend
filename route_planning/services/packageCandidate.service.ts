// ─────────────────────────────────────────────────────────────────────────────
//  packageCandidateService.ts
//  Fetches packages that are ready to be put on a route today.
//
//  Two separate queries because the criteria differ:
//    • Transporter: packages that need to MOVE between branches
//    • Deliverer:   packages that are at their final branch and need home delivery
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import PackageModel from "../../models/package.model";
import { PackageCandidate, Coords } from "../types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSPORTER CANDIDATES
//
//  Criteria:
//    • status = "at_origin_branch"  (sitting at the branch, ready to ship)
//    • currentBranchId = this branch  (physically here)
//    • destinationBranchId exists AND ≠ currentBranchId (needs to travel)
//    • currentRouteId is null  (not already on a route today)
//    • senderType = "freelancer" | "client"  (any sender)
//    • companyId matches  (scoped to this company)
// ─────────────────────────────────────────────────────────────────────────────

export async function getTransporterCandidates(
  branchId:  mongoose.Types.ObjectId,
  companyId: mongoose.Types.ObjectId,
): Promise<PackageCandidate[]> {
  const docs = await PackageModel.find({
    companyId,
    currentBranchId:      branchId,
    status:               "at_origin_branch",
    destinationBranchId:  { $exists: true, $ne: branchId },
    currentRouteId:       null,
  })
    .select(
      "_id weight volume isFragile deliveryType deliveryPriority " +
      "destinationBranchId",
    )
    .lean();

  return docs.map((d: any) => ({
    _id:                d._id,
    weight:             d.weight,
    volume:             d.volume ?? 0,
    isFragile:          d.isFragile ?? false,
    deliveryType:       d.deliveryType,
    deliveryPriority:   d.deliveryPriority ?? "standard",
    destinationBranchId: d.destinationBranchId,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  DELIVERER CANDIDATES
//
//  Criteria:
//    • status = "at_destination_branch"  (arrived, waiting for last-mile)
//    • currentBranchId = this branch
//    • deliveryType = "home"  (branch_pickup packages are self-collected)
//    • destination.location.coordinates exists  (need GPS to route)
//    • currentRouteId is null
//    • companyId matches
//
//  Packages without destination.location.coordinates are returned separately
//  in `skipped` so the orchestrator can log them without silently dropping them.
// ─────────────────────────────────────────────────────────────────────────────

export interface DelivererCandidateResult {
  candidates: PackageCandidate[];
  /** Packages skipped because destination coordinates are missing */
  skipped:    { _id: mongoose.Types.ObjectId; reason: string }[];
}

export async function getDelivererCandidates(
  branchId:  mongoose.Types.ObjectId,
  companyId: mongoose.Types.ObjectId,
): Promise<DelivererCandidateResult> {
  const docs = await PackageModel.find({
    companyId,
    currentBranchId: branchId,
    status:          "at_destination_branch",
    deliveryType:    "home",
    currentRouteId:  null,
  })
    .select(
      "_id weight volume isFragile deliveryType deliveryPriority " +
      "destination",
    )
    .lean();

  const candidates: PackageCandidate[] = [];
  const skipped:    { _id: mongoose.Types.ObjectId; reason: string }[] = [];

  for (const d of docs as any[]) {
    const coords = d.destination?.location?.coordinates as Coords | undefined;

    if (!coords || coords.length !== 2) {
      skipped.push({
        _id:    d._id,
        reason: "Missing destination.location.coordinates — cannot route",
      });
      continue;
    }

    candidates.push({
      _id:              d._id,
      weight:           d.weight,
      volume:           d.volume ?? 0,
      isFragile:        d.isFragile ?? false,
      deliveryType:     d.deliveryType,
      deliveryPriority: d.deliveryPriority ?? "standard",
      destination: {
        coordinates:   coords,
        recipientName:  d.destination.recipientName,
        recipientPhone: d.destination.recipientPhone,
        address:        d.destination.address ?? "",
        city:           d.destination.city    ?? "",
        state:          d.destination.state   ?? "",
      },
    });
  }

  return { candidates, skipped };
}