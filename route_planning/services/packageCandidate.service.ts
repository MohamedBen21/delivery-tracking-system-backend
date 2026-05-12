// ─────────────────────────────────────────────────────────────────────────────
//  packageCandidateService.ts
//  Fetches packages that are ready to be put on a route today.
//
//  Hub model changes
//  ──────────────────
//  getTransporterCandidates now accepts an optional isHub flag.
//
//  Regular branch (isHub = false, default):
//    status = "at_origin_branch" — package is sitting here, needs to ship out.
//    This is the original behaviour, unchanged.
//
//  Hub branch (isHub = true):
//    The hub optimizer works with MANIFESTS, not raw packages.  Raw packages
//    only appear at a hub via the legacy (non-hub) transporter path, which
//    means they arrived from another branch and their final destination is
//    still elsewhere.  The correct query is:
//      status = "at_destination_branch"     ← arrived at this hub
//      destinationBranchId ≠ this hub       ← NOT their final stop
//    These packages still need onward transport and would be picked up by a
//    legacy transporter running inter_branch from the hub.
//
//    Note: packages whose destinationBranchId === this hub are already at
//    their correct branch and should NOT be re-transported.  They are picked
//    up by a deliverer, not a transporter.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import PackageModel from "../../models/package.model";
import { PackageCandidate, Coords } from "../types.util";

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSPORTER CANDIDATES
// ─────────────────────────────────────────────────────────────────────────────

export async function getTransporterCandidates(
  branchId:  mongoose.Types.ObjectId,
  companyId: mongoose.Types.ObjectId,
  isHub:     boolean = false,
): Promise<PackageCandidate[]> {

  let query: Record<string, any>;

  if (isHub) {
    // Hub: pick up packages that transited through and need to continue.
    // These are packages that arrived here but whose final destination is
    // a different branch — they need another transporter leg.
    query = {
      companyId,
      currentBranchId:     branchId,
      status:              "at_destination_branch",
      destinationBranchId: { $exists: true, $ne: branchId },
      currentRouteId:      null,
    };
  } else {
    // Regular branch: packages sitting here, ready to ship out.
    query = {
      companyId,
      currentBranchId:     branchId,
      status:              "at_origin_branch",
      destinationBranchId: { $exists: true, $ne: branchId },
      currentRouteId:      null,
    };
  }

  const docs = await PackageModel.find(query)
    .select(
      "_id weight volume isFragile deliveryType deliveryPriority " +
      "destinationBranchId",
    )
    .lean();

  return (docs as any[]).map((d) => ({
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
//  Unchanged — deliverers always pick up from "at_destination_branch" at
//  their home branch and deliver to customer addresses.
// ─────────────────────────────────────────────────────────────────────────────

export interface DelivererCandidateResult {
  candidates: PackageCandidate[];
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
    // Only packages whose final destination IS this branch
    destinationBranchId: branchId,
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
        coordinates:    coords,
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