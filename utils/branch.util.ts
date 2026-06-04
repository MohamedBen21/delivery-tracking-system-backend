// ─────────────────────────────────────────────────────────────────────────────
//  utils/findNearestHub.util.ts
//
//  Fix (Problem 3 — root cause):
//  ──────────────────────────────
//  For home delivery packages, destinationBranchId must be set to the
//  nearest REGIONAL MAIN HUB, not the nearest any-branch.
//
//  Why hubs only?
//    A home delivery package travels: origin branch → hub → deliverer.
//    The hub is the correct routing anchor because:
//      1. Hub-to-hub transporters carry manifests between hubs.
//      2. Hub-to-branch transporters distribute from hub to local branches.
//      3. Deliverers operate out of the hub that serves the customer's area.
//
//    If destinationBranchId is set to a local branch instead of a hub,
//    the package gets routed to that small branch but there is no deliverer
//    there to do last-mile delivery — it sits stranded.
//
//  The existing findNearestBranch() finds any branch, which can return a
//  local branch that has no deliverers. This function queries only branches
//  with branchType = "regional_main_hub".
//
//  Usage (in createPackage):
//    Replace: findNearestBranch([lon, lat], companyId)
//    With:    findNearestHub([lon, lat], companyId)
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import BranchModel from "../models/branch.model";

/**
 * Returns the _id of the nearest active regional_main_hub to the given
 * [longitude, latitude] coordinates, scoped to a company.
 *
 * Uses MongoDB's $near geospatial query on the branch location index.
 * Falls back to a haversine-sorted in-memory search if $near is unavailable.
 *
 * Returns null if no active hub is found (caller should surface a 400 error).
 */
export async function findNearestHub(
  coordinates: [number, number],   // [longitude, latitude]
  companyId:   mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | null> {

  // Primary: use $nearSphere for efficient indexed geospatial lookup.
  // Limit to 1 result — we only need the closest hub.
  try {
    const hub = await BranchModel.findOne({
      companyId,
      status:     "active",
      branchType: "regional_main_hub",
      "location.coordinates": {
        $nearSphere: {
          $geometry: {
            type:        "Point",
            coordinates,             // [lng, lat]
          },
          $maxDistance: 2_000_000,   // 2 000 km — covers all of Algeria
        },
      },
    })
      .select("_id")
      .lean();

    if (hub) return hub._id as mongoose.Types.ObjectId;
  } catch {
    // $nearSphere requires a 2dsphere index. If the index is missing or
    // the query fails for any reason, fall back to the haversine approach.
  }

  // Fallback: load all active hubs and sort by haversine distance in JS.
  // This is only reached if the 2dsphere index is not yet built.
  const hubs = await BranchModel.find({
    companyId,
    status:     "active",
    branchType: "regional_main_hub",
    "location.coordinates": { $exists: true, $ne: [] },
  })
    .select("_id location.coordinates")
    .lean();

  if (hubs.length === 0) return null;

  const [lon, lat] = coordinates;

  let closestId: mongoose.Types.ObjectId | null = null;
  let closestDist = Infinity;

  for (const hub of hubs) {
    const [hLon, hLat] = (hub as any).location.coordinates as [number, number];
    const dist = haversineKm([lon, lat], [hLon, hLat]);
    if (dist < closestDist) {
      closestDist = dist   ;
      closestId   = hub._id as mongoose.Types.ObjectId;
    }
  }

  return closestId;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Internal haversine — avoids importing from route-planning utils which
//  may not be available in all environments.
// ─────────────────────────────────────────────────────────────────────────────

function haversineKm(a: [number, number], b: [number, number]): number {
  const R      = 6371;
  const dLat   = toRad(b[1] - a[1]);
  const dLon   = toRad(b[0] - a[0]);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}