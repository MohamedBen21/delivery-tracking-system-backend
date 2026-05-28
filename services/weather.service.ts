import { Coordinates, WeatherResult, WeatherSeverity } from './eta.types';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

interface OpenMeteoResponse {
  current: {
    weather_code: number;
    wind_speed_10m: number;
    temperature_2m: number;
  };
}

const WMO_SEVERITY_MAP: Array<{
  codes: number[];
  severity: WeatherSeverity;
  factor: number;
  label: string;
}> = [
  { codes: [0, 1],               severity: 'clear',      factor: 0,    label: 'Clear conditions' },
  { codes: [2, 3],               severity: 'clear',      factor: 0.02, label: 'Cloudy' },
  { codes: [45, 48],             severity: 'fog',        factor: 0.25, label: 'Fog — reduced visibility' },
  { codes: [51, 53, 61, 80],    severity: 'light_rain', factor: 0.12, label: 'Light rain' },
  { codes: [55, 63, 65, 81, 82],severity: 'heavy_rain', factor: 0.22, label: 'Heavy rain' },
  { codes: [71, 73],             severity: 'snow',       factor: 0.28, label: 'Snow' },
  { codes: [75, 77, 85, 86],    severity: 'snow',       factor: 0.40, label: 'Heavy snow' },
  { codes: [95, 96, 99],        severity: 'storm',      factor: 0.35, label: 'Thunderstorm' },
];

const WMO_LOOKUP = new Map<number, typeof WMO_SEVERITY_MAP[number]>();
for (const entry of WMO_SEVERITY_MAP) {
  for (const code of entry.codes) {
    WMO_LOOKUP.set(code, entry);
  }
}

function mapWMOCode(code: number): WeatherResult {
  const match = WMO_LOOKUP.get(code);
  if (match) {
    return { factor: match.factor, severity: match.severity, label: match.label, wmoCode: code };
  }
  return { factor: 0.05, severity: 'clear', label: 'Unknown conditions', wmoCode: code };
}

function applyWindBoost(result: WeatherResult, windSpeedKmh: number): WeatherResult {
  if (windSpeedKmh > 70) {
    return { ...result, factor: result.factor + 0.10, label: result.label + ' + high winds' };
  }
  if (windSpeedKmh > 50) {
    return { ...result, factor: result.factor + 0.05, label: result.label + ' + strong winds' };
  }
  return result;
}

export async function fetchWeatherFactor(coords: Coordinates): Promise<WeatherResult> {
  try {
    const url = new URL(OPEN_METEO_URL);
    url.searchParams.set('latitude',     coords.lat.toString());
    url.searchParams.set('longitude',    coords.lon.toString());
    url.searchParams.set('current',      'weather_code,wind_speed_10m,temperature_2m');
    url.searchParams.set('forecast_days','1');

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);

    const data: OpenMeteoResponse = await response.json();
    const { weather_code, wind_speed_10m } = data.current;

    let result = mapWMOCode(weather_code);
    result = applyWindBoost(result, wind_speed_10m);
    return result;
  } catch (err) {
    console.warn('[WeatherService] Failed to fetch weather, using clear fallback:', err);
    return { factor: 0, severity: 'clear', label: 'Weather unavailable', wmoCode: undefined };
  }
}