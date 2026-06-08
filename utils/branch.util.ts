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

// ─────────────────────────────────────────────────────────────────────────────
//  Commune-based branch lookup
//  ────────────────────────────
//  Used by createPackage (branch_pickup flow) to automatically resolve the
//  destinationBranchId from the commune name the freelancer typed, instead
//  of requiring them to know and supply the branch ObjectId.
//
//  Flow:
//    1. Match the input string → commune record from communes.json
//       (case-insensitive, strips diacritics, falls back to post_code match).
//    2. Query BranchModel for an active branch whose servesCommunes array
//       contains that commune id, scoped to the company.
//    3. Return { branchId, communeCoordinates } so the caller can set both
//       finalDestinationBranchId AND the package's delivery GPS coordinates
//       in one shot.
//
//  Commune data is loaded once per process (module-level cache) from
//  data/communes.json relative to the project root.  The path can be
//  overridden via the COMMUNES_JSON_PATH env variable.
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import fs   from "fs";

export interface ICommune {
  id:        string;
  post_code: string;
  name:      string;
  wilaya_id: string;
  ar_name:   string;
  longitude: string;  // string in the JSON — parse before use
  latitude:  string;
}

/** Module-level cache so the JSON is only read once per process. */
let _communesCache: ICommune[] | null = null;

export function loadCommunes(): ICommune[] {
  if (_communesCache) return _communesCache;
  const jsonPath =
    process.env.COMMUNES_JSON_PATH ??
    path.resolve(process.cwd(), "data", "communes.json");
  const raw = fs.readFileSync(jsonPath, "utf-8");
  _communesCache = JSON.parse(raw) as ICommune[];
  return _communesCache;
}

/**
 * Strips common French/Arabic diacritics and lowercases a string so that
 * "Béjaïa", "bejaia", and "BEJAIA" all normalise to the same key.
 */
function normaliseCommune(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .trim();
}

/**
 * Finds a commune record that matches the given string.
 * Matching order (first hit wins):
 *   1. Exact normalised name match
 *   2. Post-code exact match (useful for numeric input)
 *   3. Partial normalised name match (commune name starts with input)
 *
 * Returns null if nothing matches.
 */
export function lookupCommune(input: string): ICommune | null {
  const communes  = loadCommunes();
  const normInput = normaliseCommune(input);

  // 1 — exact name
  let found = communes.find(c => normaliseCommune(c.name) === normInput);
  if (found) return found;

  // 2 — post code
  found = communes.find(c => c.post_code === input.trim());
  if (found) return found;

  // 3 — starts-with (for partial typing like "Beja" → "Béjaïa")
  found = communes.find(c => normaliseCommune(c.name).startsWith(normInput));
  if (found) return found;

  return null;
}

export interface ICommuneBranchResult {
  branchId:    mongoose.Types.ObjectId;
  branchDoc:   any;                        // lean branch document for response building
  communeId:   string;
  communeName: string;
  coordinates: [number, number] | null;    // [lon, lat] from communes.json, null if missing
}

/**
 * Given a commune name (as typed by the freelancer) and a companyId, finds
 * the active branch that has declared it handles that commune.
 *
 * Returns null when:
 *   - The commune name doesn't match any record in communes.json, OR
 *   - No active branch for this company lists that commune id in servesCommunes.
 *
 * The caller decides what to do on null (surface a clear error or fall back
 * to requiring a manual destinationBranchId).
 */
export async function findBranchByCommune(
  communeInput: string,
  companyId:    mongoose.Types.ObjectId,
  session?:     mongoose.ClientSession,
): Promise<ICommuneBranchResult | null> {

  // Step 1: resolve commune record
  const commune = lookupCommune(communeInput);
  if (!commune) return null;

  // Step 2: find branch that serves this commune
  const branch = await BranchModel.findOne({
    companyId,
    status:         "active",
    servesCommunes: commune.id,
  })
    .session(session ?? null)
    .lean();

  if (!branch) return null;

  // Parse coordinates — longitude/latitude are strings in the JSON
  const lon = parseFloat(commune.longitude);
  const lat = parseFloat(commune.latitude);
  const coordinates: [number, number] | null =
    !isNaN(lon) && !isNaN(lat) ? [lon, lat] : null;

  return {
    branchId:    branch._id as mongoose.Types.ObjectId,
    branchDoc:   branch,
    communeId:   commune.id,
    communeName: commune.name,
    coordinates,
  };
}

