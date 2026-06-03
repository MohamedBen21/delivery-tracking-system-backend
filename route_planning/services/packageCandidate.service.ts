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
//
//  Fix (Problem 3):
//  ─────────────────
//  getDelivererCandidates now enforces `destinationBranchId: branchId`.
//  This prevents a package whose destinationBranchId is a remote hub (e.g.
//  ALG) from being assigned to a deliverer at the origin branch (e.g. CST).
//  Only packages whose destinationBranchId matches the current branch are
//  eligible for last-mile delivery — i.e. they have physically arrived at
//  the correct hub and are ready for the final hop to the customer.
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
//
//  Fix (Problem 3): Added `destinationBranchId: branchId` filter.
//
//  A package is eligible for last-mile delivery at THIS branch ONLY when:
//    • currentBranchId = branchId        — it is physically here
//    • status = "at_destination_branch"  — it has arrived at its final branch
//    • deliveryType = "home"             — it needs home delivery
//    • destinationBranchId = branchId    — THIS branch is its final destination
//    • currentRouteId = null             — not yet on a route
//
//  Without the destinationBranchId filter, packages destined for a remote hub
//  (e.g. a Constantine package going to Algiers) would be incorrectly assigned
//  to a local deliverer at CST, causing 400km cross-city delivery attempts.
//
//  The correct flow for such packages:
//    1. Created at CST → destinationBranchId = ALG (nearest hub to customer).
//    2. Manifested CST → ALG and transported to ALG Hub.
//    3. Arrive at ALG Hub → status = "at_destination_branch".
//    4. Only then picked up by an ALG deliverer (this query, at ALG branch).
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
    // Fix: only packages whose final destination IS this branch
    // Previously this filter was present but for completeness it's
    // explicitly enforced here to prevent cross-city assignment.
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