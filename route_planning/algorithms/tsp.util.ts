// ─────────────────────────────────────────────────────────────────────────────
//  tsp.util.ts
//  Travelling Salesman Problem solver for route stop ordering.
//
//  Two algorithms, same interface:
//    1. nearestNeighbour  — O(n²), fast, ~15-20% above optimal
//    2. twoOpt            — O(n²) improvement pass on top of step 1,
//                           brings result to ~5% above optimal
//
//  For ≤30 stops (a realistic daily route for one driver) both run in <5ms.
// ─────────────────────────────────────────────────────────────────────────────

import { Coords, StopPoint, TSPResult } from "../types.util";
import {
  haversineKm,
  estimatedDriveMinutes,
  buildDistanceMatrix,
  RouteSpeedType,
} from "./haversine.util";

// ─────────────────────────────────────────────────────────────────────────────
//  NEAREST NEIGHBOUR
// ─────────────────────────────────────────────────────────────────────────────

export function nearestNeighbourTSP(
  origin: Coords,
  stops: StopPoint[],
  routeType: RouteSpeedType = "local_delivery",
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

export function twoOpt(
  result: TSPResult,
  origin: Coords,
  routeType: RouteSpeedType = "local_delivery",
): TSPResult {
  if (result.orderedStops.length < 4) {
    return result;
  }

  const stops = [...result.orderedStops];
  const n     = stops.length;

  const coords: Coords[] = [origin, ...stops.map((s) => s.coordinates)];
  const dist = buildDistanceMatrix(coords);

  let improved = true;

  while (improved) {
    improved = false;

    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const jNext = j + 1 < coords.length ? j + 1 : 0;

        const currentDist = dist[i - 1][i] + dist[j][jNext];
        const swapDist    = dist[i - 1][j] + dist[i][jNext];

        if (swapDist < currentDist - 1e-10) {
          reverseSegment(stops, i - 1, j - 1);

          for (let k = 1; k <= n; k++) {
            coords[k] = stops[k - 1].coordinates;
          }

          rebuildMatrix(dist, coords);
          improved = true;
        }
      }
    }
  }

  return buildTSPResult(origin, stops, routeType);
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMBINED
// ─────────────────────────────────────────────────────────────────────────────

export function optimisedTSP(
  origin: Coords,
  stops: StopPoint[],
  routeType: RouteSpeedType = "local_delivery",
): TSPResult {
  const initial = nearestNeighbourTSP(origin, stops, routeType);
  return twoOpt(initial, origin, routeType);
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function reverseSegment(stops: StopPoint[], from: number, to: number): void {
  while (from < to) {
    [stops[from], stops[to]] = [stops[to], stops[from]];
    from++;
    to--;
  }
}

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

function buildTSPResult(
  origin: Coords,
  stops: StopPoint[],
  routeType: RouteSpeedType,
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

export function annotateArrivalTimes(
  result: TSPResult,
  startTime: Date,
  dwellMinutes: number | number[] = 15,
): TSPResult & { annotatedStops: (StopPoint & { expectedArrival: Date; expectedDeparture: Date })[] } {
  let cursor = startTime.getTime();

  const annotatedStops = result.orderedStops.map((stop, i) => {
    cursor += result.segmentDriveMinutes[i] * 60_000;
    const expectedArrival = new Date(cursor);

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