// ─────────────────────────────────────────────────────────────────────────────
//  haversine.ts
//  Great-circle distance between two GPS coordinates.
//  All route planning distance/time estimates flow through here.
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
//  inter_branch : highway driving between wilayas
//  local_delivery: in-city driving with stops, traffic, narrow streets
//
//  These are conservative averages for Algeria. Adjust per operational data.
// ─────────────────────────────────────────────────────────────────────────────

export const AVG_SPEED_KMH: Record<"inter_branch" | "local_delivery", number> = {
  inter_branch:   80,
  local_delivery: 35,
};

/**
 * Converts a distance and route type to an estimated drive time in minutes.
 * Does NOT include stop dwell time — that is added separately by the builders.
 */
export function estimatedDriveMinutes(
  distanceKm: number,
  routeType: "inter_branch" | "local_delivery",
): number {
  return Math.round((distanceKm / AVG_SPEED_KMH[routeType]) * 60);
}

/**
 * Builds an N×N distance matrix from an array of coordinates.
 * Used by TSP when it needs all pairwise distances upfront.
 *
 * matrix[i][j] = haversineKm(coords[i], coords[j])
 */
export function buildDistanceMatrix(coords: Coords[]): number[][] {
  const n = coords.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(coords[i], coords[j]);
      matrix[i][j] = d;
      matrix[j][i] = d; // symmetric
    }
  }

  return matrix;
}