import { TrafficResult, TrafficLevel } from './eta.types';

interface TrafficProfile {
  hour: number;       // center of peak
  intensity: number;  // max factor at center (0–1 scale)
  width: number;      // std-deviation in hours (controls smoothness)
}

/**
 * Algiers-tuned weekday congestion peaks.
 * - Evening peak extended + widened (rush tail effect)
 * - Morning slightly stronger
 */
const WEEKDAY_PEAKS: TrafficProfile[] = [
  { hour: 8,    intensity: 0.25, width: 1.2 },  // morning rush
  { hour: 13,   intensity: 0.10, width: 1.0 },  // midday shoulder
  { hour: 18.5, intensity: 0.30, width: 2.2 },  // evening rush (extended)
];

const WEEKEND_PEAKS: TrafficProfile[] = [
  { hour: 12, intensity: 0.12, width: 2.0 },
  { hour: 17, intensity: 0.14, width: 1.8 },
];

const NIGHT_DISCOUNT = -0.04;       // 23:00–05:00 slight speed bonus
const LATE_EVENING_FLOOR = 0.06;    // city never fully clears (20:00–23:00)

function hourDistance(h: number, center: number): number {
  const diff = ((h - center + 24) % 24);
  return diff > 12 ? 24 - diff : diff;
}

function gaussianHour(
  h: number,
  center: number,
  width: number,
  intensity: number
): number {
  const dist = hourDistance(h, center);
  return intensity * Math.exp(-0.5 * Math.pow(dist / width, 2));
}

function levelFromFactor(factor: number): TrafficLevel {
  if (factor < 0.05) return 'low';
  if (factor < 0.12) return 'moderate';
  if (factor < 0.20) return 'high';
  return 'very_high';
}

const LEVEL_LABELS: Record<TrafficLevel, string> = {
  low: 'Light traffic',
  moderate: 'Moderate traffic',
  high: 'Heavy traffic',
  very_high: 'Severe congestion',
};

export function estimateTrafficFactor(
  date: Date = new Date(),
  isWeekend?: boolean
): TrafficResult {
  const hour = date.getHours() + date.getMinutes() / 60;
  const weekend = isWeekend ?? (date.getDay() === 0 || date.getDay() === 6);
  const peaks = weekend ? WEEKEND_PEAKS : WEEKDAY_PEAKS;

  let factor = peaks.reduce(
    (sum, p) => sum + gaussianHour(hour, p.hour, p.width, p.intensity),
    0
  );

  // Night discount (23:00–05:00)
  const isNight = hour >= 23 || hour < 5;
  if (isNight) factor += NIGHT_DISCOUNT;

  // Late evening floor (Algiers stays active)
  const isLateEvening = hour >= 20 && hour < 23;
  if (!weekend && isLateEvening) {
    factor = Math.max(factor, LATE_EVENING_FLOOR);
  }

  factor = Math.max(-0.04, Math.min(0.40, factor));

  const level = levelFromFactor(factor);

  return {
    factor,
    level,
    label: LEVEL_LABELS[level],
  };
}