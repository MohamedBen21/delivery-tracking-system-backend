import { Coordinates, OSRMResponse, ETAResult } from './eta.types';
import { estimateTrafficFactor } from './traffic.service';
import { fetchWeatherFactor } from './weather.service';

const MAX_ADJUSTMENT  = 0.60;
const MIN_DURATION_SEC = 60;

/**
 * Dampening function: prevents two large factors from stacking linearly.
 *
 * Example:
 *   traffic=0.25, weather=0.22 → naive sum = 0.47
 *   dampened = 1 - e^(-0.47) = 0.375  (more realistic)
 *
 * Real-world rationale: bad weather IS partially reflected in bad traffic,
 * so the two factors overlap rather than add independently.
 */
function dampen(trafficFactor: number, weatherFactor: number): number {
  const raw = trafficFactor + weatherFactor;
  const dampened = 1 - Math.exp(-raw);
  return Math.min(dampened, MAX_ADJUSTMENT);
}

function confidenceLevel(
  trafficFactor: number,
  weatherFactor: number
): ETAResult['confidence'] {
  const combined = trafficFactor + weatherFactor;
  if (combined < 0.10) return 'high';
  if (combined < 0.30) return 'medium';
  return 'low';
}

export interface ETAInput {
  osrm: OSRMResponse;
  origin: Coordinates;
  destination: Coordinates;
  departureTime?: Date;
}

export async function calculateSmartETA(input: ETAInput): Promise<ETAResult> {
  const { osrm, origin, destination } = input;
  const now = input.departureTime ?? new Date();

  // Use midpoint for weather — more representative than either endpoint alone
  const midpoint: Coordinates = {
    lat: (origin.lat + destination.lat) / 2,
    lon: (origin.lon + destination.lon) / 2,
  };

  const [trafficResult, weatherResult] = await Promise.all([
    Promise.resolve(estimateTrafficFactor(now)),
    fetchWeatherFactor(midpoint),
  ]);

  const adjustment = dampen(trafficResult.factor, weatherResult.factor);
  const baseDurationSec = Math.max(osrm.baseDuration, MIN_DURATION_SEC);
  const finalDurationSec = baseDurationSec * (1 + adjustment);
  const estimatedArrival = new Date(now.getTime() + finalDurationSec * 1000);

  return {
    baseDurationMin:   Math.round(baseDurationSec / 60),
    finalDurationMin:  Math.round(finalDurationSec / 60),
    adjustmentPercent: Math.round(adjustment * 100),
    trafficResult,
    weatherResult,
    estimatedArrival,
    confidence: confidenceLevel(trafficResult.factor, weatherResult.factor),
  };
}