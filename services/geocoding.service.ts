const NOMINATIM_BASE = process.env.NOMINATIM_URL ?? "http://localhost:8080";



export interface GeocodeSuggestion {
  displayName: string;   // human-readable label shown in the autocomplete
  lat: number;
  lon: number;
  type: string;          // city / town / village / suburb / …
  importance: number;    // Nominatim's 0–1 relevance score
}

export interface ReverseGeocodeResult {
  displayName: string;
  address: {
    road?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  lat: number;
  lon: number;
}

// ─── Input normalisation ──────────────────────────────────────────────────────

/**
 * Normalise Arabic / French / Arabizi text before sending to Nominatim.
 *
 * Steps applied:
 *   1. Trim + collapse extra whitespace
 *   2. Lowercase (safe for Arabic – has no case, harmless)
 *   3. Arabic letter variants → canonical form
 *      أ إ آ ٱ  →  ا
 *      ة        →  ه
 *      ى        →  ي
 *   4. Remove diacritics (tashkeel) so "قُسَنْطِينَة" == "قسنطينة"
 */
export function normaliseInput(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    // Arabic hamza/alef variants
    .replace(/[أإآٱ]/g, "ا")
    // ta-marbuta
    .replace(/ة/g, "ه")
    // alef-maqsura
    .replace(/ى/g, "ي")
    // Arabic diacritics (tashkeel U+064B–U+065F)
    .replace(/[\u064B-\u065F]/g, "");
}

// ─── Place-type allow-list ────────────────────────────────────────────────────

/**
 * We only want administrative / populated-place results – not individual
 * streets, POIs, or post codes – because we're geocoding a city/district
 * for the delivery destination, not a door address.
 *
 * Adjust this list to suit your coverage area.
 */
const ALLOWED_PLACE_TYPES = new Set([
  "city",
  "town",
  "village",
  "hamlet",
  "suburb",
  "neighbourhood",
  "municipality",
  "administrative",
  "county",
  "state_district",
]);

function isAllowedType(type: string | undefined): boolean {
  return type ? ALLOWED_PLACE_TYPES.has(type) : false;
}

// ─── Geocode (text → coordinates) ────────────────────────────────────────────

/**
 * Search Nominatim for a place name.
 *
 * @param query  Raw user input (any language, any casing)
 * @param limit  Maximum number of suggestions to return (default 8, max 10)
 *
 * Returns up to `limit` suggestions sorted by Nominatim importance score.
 */
export async function geocodeAddress(
  query: string,
  limit = 8,
): Promise<GeocodeSuggestion[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 10);
  const normalised = normaliseInput(query);

  if (!normalised) return [];

  const params = new URLSearchParams({
    q: normalised,
    format: "json",
    addressdetails: "1",
    limit: String(safeLimit),
    // Accept-Language tells Nominatim which language to prefer for display_name.
    // "ar,fr,en" means: Arabic first, then French, then English.
    "accept-language": "ar,fr,en",
  });

  const url = `${NOMINATIM_BASE}/search?${params.toString()}`;

  let raw: any[];

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "DeliveryApp/1.0" },
      signal: AbortSignal.timeout(5_000), // 5 s hard timeout
    });

    if (!res.ok) {
      throw new Error(`Nominatim HTTP ${res.status}`);
    }

    raw = await res.json();
  } catch (err: any) {
    // Surface a friendlier error so the controller can handle it
    throw new Error(`Geocoding service unavailable: ${err.message}`);
  }

  // Filter to useful place types, then map to our DTO
  const suggestions: GeocodeSuggestion[] = raw
    .filter((r) => isAllowedType(r.type) || isAllowedType(r.addresstype))
    .map((r) => ({
      displayName: r.display_name as string,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      type: (r.type ?? r.addresstype ?? "unknown") as string,
      importance: parseFloat(r.importance ?? "0"),
    }))
    // Sort highest importance first (Nominatim already does this, but be safe)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, safeLimit);

  return suggestions;
}

// ─── Reverse geocode (coordinates → text) ────────────────────────────────────

/**
 * Convert a lat/lon pair back into a readable address.
 * Useful to confirm the location the deliverer is standing at.
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<ReverseGeocodeResult | null> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "json",
    addressdetails: "1",
    "accept-language": "ar,fr,en",
  });

  const url = `${NOMINATIM_BASE}/reverse?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "DeliveryApp/1.0" },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);

    const data = await res.json();

    // Nominatim returns { error: "Unable to geocode" } when nothing is found
    if (data.error) return null;

    return {
      displayName: data.display_name,
      address: {
        road:      data.address?.road,
        suburb:    data.address?.suburb,
        city:      data.address?.city ?? data.address?.town ?? data.address?.village,
        town:      data.address?.town,
        village:   data.address?.village,
        state:     data.address?.state,
        postcode:  data.address?.postcode,
        country:   data.address?.country,
      },
      lat: parseFloat(data.lat),
      lon: parseFloat(data.lon),
    };
  } catch (err: any) {
    throw new Error(`Reverse geocoding service unavailable: ${err.message}`);
  }
}