import mongoose from "mongoose";
import BranchModel from "../models/branch.model";
import path from "path";
import fs   from "fs";


export async function findNearestHub(
  coordinates: [number, number],   // [longitude, latitude]
  companyId:   mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | null> {

  
  try {
    const hub = await BranchModel.findOne({
      companyId,
      status:     "active",
      branchType: "regional_main_hub",
      "location.coordinates": {
        $nearSphere: {
          $geometry: {
            type:        "Point",
            coordinates,             
          },
          $maxDistance: 2_000_000,  
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


export interface ICommune {
  id:        string;
  post_code: string;
  name:      string;
  wilaya_id: string;
  ar_name:   string;
  longitude: string;  
  latitude:  string;
}


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


function normaliseCommune(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") 
    .trim();
}


export function lookupCommune(input: string): ICommune | null {
  const communes  = loadCommunes();
  const normInput = normaliseCommune(input);


  let found = communes.find(c => normaliseCommune(c.name) === normInput);
  if (found) return found;

  found = communes.find(c => c.post_code === input.trim());
  if (found) return found;

  found = communes.find(c => normaliseCommune(c.name).startsWith(normInput));
  if (found) return found;

  return null;
}

export interface ICommuneBranchResult {
  branchId:    mongoose.Types.ObjectId;
  branchDoc:   any;                        
  communeId:   string;
  communeName: string;
  coordinates: [number, number] | null;    
}


export async function findBranchByCommune(
  communeInput: string,
  companyId:    mongoose.Types.ObjectId,
  session?:     mongoose.ClientSession,
): Promise<ICommuneBranchResult | null> {


  const commune = lookupCommune(communeInput);
  if (!commune) return null;


  const branch = await BranchModel.findOne({
    companyId,
    status:         "active",
    servesCommunes: commune.id,
  })
    .session(session ?? null)
    .lean();

  if (!branch) return null;


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

