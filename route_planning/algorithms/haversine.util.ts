// ─────────────────────────────────────────────────────────────────────────────
//  haversine.util.ts
//  Great-circle distance between two GPS coordinates.
//  All route planning distance/time estimates flow through here.
//
//  Hub model addition
//  ──────────────────
//  Added "hub_to_hub" and "hub_to_branch" to AVG_SPEED_KMH.
//  hub_to_hub uses a higher speed (highway inter-wilaya trunk roads).
//  hub_to_branch mirrors inter_branch (same road types).
//  estimatedDriveMinutes now accepts the full RouteType union so callers
//  don't have to cast.
// ─────────────────────────────────────────────────────────────────────────────

/** [longitude, latitude] pair — matches GeoJSON coordinate order */
export type Coords = [number, number];

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Returns the straight-line distance in km between two [lng, lat] points.
 * Accuracy: <0.5% error for distances up to 1000 km (sufficient for Algeria).
 */
export function haversineKm(a: Coords, b: Coords): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const h =
    sinLat * sinLat +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Speed assumptions
//
//  inter_branch   : highway driving between wilayas (existing)
//  local_delivery : in-city driving with stops and traffic (existing)
//  hub_to_hub     : long-haul inter-city trunk roads — higher speed because
//                   these routes connect major hubs (e.g. Algiers ↔ Oran)
//                   and use the autoroute / RN1 where available.
//  hub_to_branch  : same as inter_branch — hub serves local branches within
//                   the same wilaya or adjacent ones (shorter distances,
//                   secondary roads).
//
//  All values are conservative operational averages for Algeria.
//  Adjust per observed GPS data once live.
// ─────────────────────────────────────────────────────────────────────────────

export type RouteSpeedType =
  | "inter_branch"
  | "local_delivery"
  | "hub_to_hub"
  | "hub_to_branch";

export const AVG_SPEED_KMH: Record<RouteSpeedType, number> = {
  inter_branch:   80,
  local_delivery: 35,
  hub_to_hub:     90,   // autoroute / RN1 long-haul
  hub_to_branch:  80,   // same as inter_branch
};

/**
 * Converts a distance and route type to an estimated drive time in minutes.
 * Does NOT include stop dwell time — that is added separately by the builders.
 *
 * Accepts all four route speed types.  Falls back to 60 km/h for any unknown
 * value so callers never get NaN.
 */
export function estimatedDriveMinutes(
  distanceKm: number,
  routeType:  RouteSpeedType | string,
): number {
  const speed = AVG_SPEED_KMH[routeType as RouteSpeedType] ?? 60;
  return Math.round((distanceKm / speed) * 60);
}






//// legacy ---- not used anymore
/**
 * Builds an N×N distance matrix from an array of coordinates.
 * Used by TSP when it needs all pairwise distances upfront.
 *
 * matrix[i][j] = haversineKm(coords[i], coords[j])
 */
export function buildDistanceMatrix(coords: Coords[]): number[][] {
  const n = coords.length;
  const matrix: number[][] = Array.from(
    { length: n },
    () => new Array(n).fill(0),
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(coords[i], coords[j]);
      matrix[i][j] = d;
      matrix[j][i] = d; // symmetric
    }
  }

  return matrix;
}