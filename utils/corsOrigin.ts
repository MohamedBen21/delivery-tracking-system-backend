const DEFAULT_ORIGIN = "http://localhost:3000";

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

export function resolveCorsOrigin(
  value: string | undefined,
  fallback = DEFAULT_ORIGIN,
): string | string[] {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return fallback;
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();

    if (!inner) {
      return fallback;
    }

    const origins = inner
      .split(",")
      .map((origin) => stripQuotes(origin.trim()))
      .filter(Boolean);

    return origins.length > 0 ? origins : fallback;
  }

  return stripQuotes(trimmed);
}