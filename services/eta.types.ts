export interface Coordinates {
  lat: number;
  lon: number;
}

export interface OSRMResponse {
  baseDuration: number;  // seconds
  distance: number;      // meters
  avgSpeedKmh: number;
}

export type TrafficLevel = 'low' | 'moderate' | 'high' | 'very_high';
export type WeatherSeverity = 'clear' | 'light_rain' | 'heavy_rain' | 'storm' | 'fog' | 'snow';

export interface TrafficResult {
  factor: number;  // e.g. 0.20 = +20%
  level: TrafficLevel;
  label: string;
}

export interface WeatherResult {
  factor: number;
  severity: WeatherSeverity;
  label: string;
  wmoCode?: number;
}

export interface ETAResult {
  baseDurationMin: number;
  finalDurationMin: number;
  adjustmentPercent: number;
  trafficResult: TrafficResult;
  weatherResult: WeatherResult;
  estimatedArrival: Date;
  confidence: 'high' | 'medium' | 'low';
}