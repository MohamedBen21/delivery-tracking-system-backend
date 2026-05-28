import { Coordinates, OSRMResponse } from './eta.types';

const OSRM_BASE_URL = process.env.OSRM_BASE_URL ?? 'http://localhost:5000';

export async function getOSRMRoute(
  origin: Coordinates,
  destination: Coordinates
): Promise<OSRMResponse> {
  const url =
    `${OSRM_BASE_URL}/route/v1/driving/` +
    `${origin.lon},${origin.lat};${destination.lon},${destination.lat}` +
    `?overview=false&annotations=false`;

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`OSRM error: HTTP ${response.status}`);

  const data = await response.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(`OSRM returned no route: ${data.code}`);
  }

  const route = data.routes[0];
  const avgSpeedKmh = (route.distance / route.duration) * 3.6;

  return {
    baseDuration: route.duration,
    distance:     route.distance,
    avgSpeedKmh:  Math.round(avgSpeedKmh * 10) / 10,
  };
}