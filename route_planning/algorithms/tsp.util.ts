// ─────────────────────────────────────────────────────────────────────────────
//  tsp.ts
//  Travelling Salesman Problem solver for route stop ordering.
//
//  Two algorithms, same interface:
//    1. nearestNeighbour  — O(n²), fast, ~15-20% above optimal
//    2. twoOpt            — O(n²) improvement pass on top of step 1,
//                           brings result to ~5% above optimal
//
//  For ≤30 stops (a realistic daily route for one driver) both run in <5ms.
//  nearestNeighbour alone is sufficient for production.
//  twoOpt is available as an optional improvement step.
//
//  Why not exact TSP:
//    Exact TSP is NP-hard. For 20 stops, brute force = 20! ≈ 2.4 × 10¹⁸
//    operations. Even with dynamic programming (Held-Karp), it's O(2ⁿ · n²)
//    which is ~400M operations for 20 stops — too slow for a nightly batch
//    that may run across dozens of branches simultaneously.
// ─────────────────────────────────────────────────────────────────────────────

import { Coords, StopPoint, TSPResult } from "../types.util";
import { haversineKm, estimatedDriveMinutes, buildDistanceMatrix } from "./haversine.util";

// ─────────────────────────────────────────────────────────────────────────────
//  NEAREST NEIGHBOUR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orders stops to minimise total driving distance using the nearest-neighbour
 * heuristic: always go to the closest unvisited stop next.
 *
 * @param origin   Starting point (the branch coordinates — not a stop itself)
 * @param stops    Stops to visit (order does not matter on input)
 * @param routeType  Used to compute drive-time estimates per segment
 *
 * @returns Ordered stops with per-segment distances and drive times.
 *          The route starts at `origin` and ends at the last stop
 *          (open route — drivers don't return to branch in this model).
 */
export function nearestNeighbourTSP(
  origin: Coords,
  stops: StopPoint[],
  routeType: "inter_branch" | "local_delivery" = "local_delivery",
): TSPResult {
  if (stops.length === 0) {
    return { orderedStops: [], totalDistanceKm: 0, segmentDistances: [], segmentDriveMinutes: [] };
  }

  if (stops.length === 1) {
    const d = haversineKm(origin, stops[0].coordinates);
    return {
      orderedStops:        stops,
      totalDistanceKm:     d,
      segmentDistances:    [d],
      segmentDriveMinutes: [estimatedDriveMinutes(d, routeType)],
    };
  }

  const remaining = [...stops];
  const ordered:   StopPoint[] = [];
  const segDist:   number[]    = [];
  const segMins:   number[]    = [];

  let current = origin;
  let total   = 0;

  while (remaining.length > 0) {
    let bestIdx  = 0;
    let bestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current, remaining[i].coordinates);
      if (d < bestDist) {
        bestDist = d;
        bestIdx  = i;
      }
    }

    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    segDist.push(bestDist);
    segMins.push(estimatedDriveMinutes(bestDist, routeType));
    total  += bestDist;
    current = next.coordinates;
  }

  return {
    orderedStops:        ordered,
    totalDistanceKm:     total,
    segmentDistances:    segDist,
    segmentDriveMinutes: segMins,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  2-OPT IMPROVEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Improves a TSP result using the 2-opt swap heuristic.
 *
 * 2-opt repeatedly finds two edges in the route that, when "uncrossed",
 * produce a shorter total distance. It repeats until no improving swap exists.
 *
 * Complexity: O(n²) per iteration, typically converges in 2–5 iterations
 * for route sizes ≤30 → effectively O(n²) total.
 *
 * When to use:
 *   - Call this after nearestNeighbourTSP if you want ~5% better routes
 *   - Skip it if speed matters more than marginal route quality
 *   - Not worth it for n < 6 (nearest-neighbour is already near-optimal)
 *
 * @param result    Output of nearestNeighbourTSP (or any TSPResult)
 * @param origin    Starting point (branch) — needed to recompute first segment
 * @param routeType For recomputing drive-time estimates
 */
export function twoOpt(
  result: TSPResult,
  origin: Coords,
  routeType: "inter_branch" | "local_delivery" = "local_delivery",
): TSPResult {
  if (result.orderedStops.length < 4) {
    // 2-opt needs at least 4 stops to make a meaningful swap
    return result;
  }

  const stops = [...result.orderedStops];
  const n     = stops.length;

  // Build full coordinate list including origin as index 0
  // so edge (0→1) represents origin→first stop
  const coords: Coords[] = [origin, ...stops.map((s) => s.coordinates)];

  // Precompute distance matrix to avoid repeated haversine calls
  const dist = buildDistanceMatrix(coords);

  let improved = true;

  while (improved) {
    improved = false;

    // Try every pair of edges (i, i+1) and (j, j+1)
    // i and j index into `coords`, so stop[i-1] and stop[j-1] in `stops`
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // Current edges:  coords[i-1]→coords[i]  and  coords[j]→coords[j+1]
        // After swap:     coords[i-1]→coords[j]  and  coords[i]→coords[j+1]
        // (the segment between i and j gets reversed)

        const jNext = j + 1 < coords.length ? j + 1 : 0;

        const currentDist = dist[i - 1][i] + dist[j][jNext];
        const swapDist    = dist[i - 1][j] + dist[i][jNext];

        if (swapDist < currentDist - 1e-10) {
          // Reverse the sub-sequence from index i to j in stops (0-indexed: i-1 to j-1)
          reverseSegment(stops, i - 1, j - 1);

          // Rebuild coords from updated stops order
          for (let k = 1; k <= n; k++) {
            coords[k] = stops[k - 1].coordinates;
          }

          // Recompute affected rows/columns in the distance matrix
          // (full rebuild is simpler and still O(n²))
          rebuildMatrix(dist, coords);

          improved = true;
        }
      }
    }
  }

  // Recompute segment distances and times from final stop order
  return buildTSPResult(origin, stops, routeType);
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMBINED: nearest-neighbour + 2-opt in one call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convenience function: runs nearest-neighbour then 2-opt improvement.
 * Use this as the default in builders for best quality with no extra wiring.
 */
export function optimisedTSP(
  origin: Coords,
  stops: StopPoint[],
  routeType: "inter_branch" | "local_delivery" = "local_delivery",
): TSPResult {
  const initial = nearestNeighbourTSP(origin, stops, routeType);
  return twoOpt(initial, origin, routeType);
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** In-place reversal of stops[from..to] (inclusive) */
function reverseSegment(stops: StopPoint[], from: number, to: number): void {
  while (from < to) {
    [stops[from], stops[to]] = [stops[to], stops[from]];
    from++;
    to--;
  }
}

/** Full in-place rebuild of a distance matrix from a coords array */
function rebuildMatrix(matrix: number[][], coords: Coords[]): void {
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(coords[i], coords[j]);
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }
}

/**
 * Computes a TSPResult from an already-ordered stop list.
 * Used after 2-opt rearranges stops so we have correct segment data.
 */
function buildTSPResult(
  origin: Coords,
  stops: StopPoint[],
  routeType: "inter_branch" | "local_delivery",
): TSPResult {
  const segDist: number[] = [];
  const segMins: number[] = [];
  let total = 0;
  let prev  = origin;

  for (const stop of stops) {
    const d = haversineKm(prev, stop.coordinates);
    segDist.push(d);
    segMins.push(estimatedDriveMinutes(d, routeType));
    total += d;
    prev   = stop.coordinates;
  }

  return {
    orderedStops:        stops,
    totalDistanceKm:     total,
    segmentDistances:    segDist,
    segmentDriveMinutes: segMins,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPECTED ARRIVAL TIME ANNOTATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Takes a TSPResult and a route start time, then returns a copy of each stop
 * annotated with an `expectedArrival` Date.
 *
 * Also accounts for dwell time at each stop (unloading / handover minutes)
 * so the next segment's clock starts after the driver leaves, not when they arrive.
 *
 * @param result         TSP result with ordered stops
 * @param startTime      When the driver departs from the origin branch
 * @param dwellMinutes   Minutes spent at each stop (unloading / signing)
 *                       Can be a single value applied to all stops, or an
 *                       array of per-stop values aligned to orderedStops.
 */
export function annotateArrivalTimes(
  result: TSPResult,
  startTime: Date,
  dwellMinutes: number | number[] = 15,
): TSPResult & { annotatedStops: (StopPoint & { expectedArrival: Date; expectedDeparture: Date })[] } {
  let cursor = startTime.getTime();

  const annotatedStops = result.orderedStops.map((stop, i) => {
    // Drive from previous point
    cursor += result.segmentDriveMinutes[i] * 60_000;
    const expectedArrival = new Date(cursor);

    // Dwell at this stop
    const dwell = Array.isArray(dwellMinutes) ? (dwellMinutes[i] ?? 15) : dwellMinutes;
    cursor += dwell * 60_000;
    const expectedDeparture = new Date(cursor);

    return { ...stop, expectedArrival, expectedDeparture };
  });

  return { ...result, annotatedStops };
}

// ─────────────────────────────────────────────────────────────────────────────
//  DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable summary of a TSPResult — useful for logging.
 *
 * Example:
 *   "5 stops | 312.4 km | ~4h 35m | [Mila → Sétif → Algiers → Oran → Guelma → Constantine]"
 */
export function formatTSPSummary(result: TSPResult): string {
  const totalMins = result.segmentDriveMinutes.reduce((a, b) => a + b, 0);
  const hours     = Math.floor(totalMins / 60);
  const mins      = totalMins % 60;
  const stopIds   = result.orderedStops.map((s) => s.id).join(" → ");

  return (
    `${result.orderedStops.length} stop(s) | ` +
    `${result.totalDistanceKm.toFixed(1)} km | ` +
    `~${hours}h ${mins}m | ` +
    `[${stopIds}]`
  );
}