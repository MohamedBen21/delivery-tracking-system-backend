/**
 * geocoding.service.ts
 *
 * Uses the official Algeria communes dataset (all ~1541 communes, 58 wilayas).
 * Place the JSON file at: src/data/algeria_communes.json
 *
 * Flow:
 *   1. /geocode/search?q=con   → searchLocalPlaces()  — instant, no network
 *   2. /geocode/resolve        → geocodeConfirmedPlace() — calls Nominatim once with full name
 */

import communesRaw from "../data/algeria_communes.json";

const NOMINATIM_BASE = process.env.NOMINATIM_URL ?? "http://nominatim:8080";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AlgeriaCommune {
  id: number;
  commune_name_ascii: string;   // French / Latin name  e.g. "El Khroub"
  commune_name: string;         // Arabic name           e.g. "الخروب"
  daira_name_ascii: string;
  daira_name: string;
  wilaya_code: string;          // "01", "25", …
  wilaya_name_ascii: string;    // "Constantine"
  wilaya_name: string;          // "قسنطينة"
}

export interface PlaceSuggestion {
  id: number;
  communeNameAscii: string;
  communeName: string;
  dairaNameAscii: string;
  dairaName: string;
  wilayaCode: string;
  wilayaNameAscii: string;
  wilayaName: string;
  label: string;   // ready-to-display label for the dropdown
}

export interface ResolvedPlace {
  communeNameAscii: string;
  communeName: string;
  wilayaNameAscii: string;
  wilayaName: string;
  wilayaCode: string;
  displayName: string;   // from Nominatim
  lat: number;
  lon: number;
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

// ─── Build the in-memory search index once at startup ────────────────────────

const communes = communesRaw as AlgeriaCommune[];

// Pre-normalise everything so search is fast on every request
interface IndexedCommune {
  original: AlgeriaCommune;
  normAscii: string;    // normalised French name
  normAr: string;       // normalised Arabic name
  normWilaya: string;   // normalised wilaya name
  normDaira: string;    // normalised daira name
}

function normaliseInput(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    // Arabic letter variants
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    // Arabic diacritics
    .replace(/[\u064B-\u065F]/g, "")
    // French accents
    .replace(/[éèêë]/g, "e")
    .replace(/[àâä]/g, "a")
    .replace(/[îï]/g, "i")
    .replace(/[ôö]/g, "o")
    .replace(/[ûü]/g, "u")
    .replace(/ç/g, "c");
}

// Export so controller can use it too
export { normaliseInput };

const INDEX: IndexedCommune[] = communes.map((c) => ({
  original: c,
  normAscii:  normaliseInput(c.commune_name_ascii),
  normAr:     normaliseInput(c.commune_name),
  normWilaya: normaliseInput(c.wilaya_name_ascii),
  normDaira:  normaliseInput(c.daira_name_ascii),
}));

// ─── Local prefix search ──────────────────────────────────────────────────────

/**
 * Searches all 1541 communes instantly from memory.
 *
 * Matches on:
 *   - French commune name (prefix and substring)
 *   - Arabic commune name (prefix and substring)
 *   - Wilaya name (so "const" matches all communes in Constantine)
 *   - Word-level prefix ("khroub" matches "El Khroub")
 *
 * Returns up to `limit` results sorted by relevance score.
 */
export function searchLocalPlaces(query: string, limit = 10): PlaceSuggestion[] {
  const q = normaliseInput(query);
  if (q.length < 2) return [];

  const results: Array<{ entry: IndexedCommune; score: number }> = [];

  for (const entry of INDEX) {
    let score = 0;

    // ── Exact match ──
    if (entry.normAscii === q || entry.normAr === q) {
      score = 300;
    }
    // ── Prefix match on French name ──
    else if (entry.normAscii.startsWith(q)) {
      score = 200 + Math.round((q.length / entry.normAscii.length) * 50);
    }
    // ── Prefix match on Arabic name ──
    else if (entry.normAr.startsWith(q)) {
      score = 200 + Math.round((q.length / entry.normAr.length) * 50);
    }
    // ── Word-level prefix on French name ("khroub" → "El Khroub") ──
    else if (entry.normAscii.split(" ").some((w) => w.startsWith(q))) {
      score = 150;
    }
    // ── Word-level prefix on Arabic name ──
    else if (entry.normAr.split(" ").some((w) => w.startsWith(q))) {
      score = 150;
    }
    // ── Substring match on French name ──
    else if (entry.normAscii.includes(q)) {
      score = 80;
    }
    // ── Substring match on Arabic name ──
    else if (entry.normAr.includes(q)) {
      score = 80;
    }
    // ── Wilaya-level match ("constantine" → all its communes) ──
    else if (entry.normWilaya.startsWith(q)) {
      score = 50;
    }

    if (score > 0) {
      results.push({ entry, score });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry: { original: c } }) => ({
      id:               c.id,
      communeNameAscii: c.commune_name_ascii,
      communeName:      c.commune_name,
      dairaNameAscii:   c.daira_name_ascii,
      dairaName:        c.daira_name,
      wilayaCode:       c.wilaya_code,
      wilayaNameAscii:  c.wilaya_name_ascii,
      wilayaName:       c.wilaya_name,
      // Dropdown label: "El Khroub — Constantine (الخروب)"
      label: `${c.commune_name_ascii} — ${c.wilaya_name_ascii} (${c.commune_name})`,
    }));
}

// ─── Geocode a confirmed selection ───────────────────────────────────────────

/**
 * Called once after the user picks a commune from the dropdown.
 * Sends the full canonical name to Nominatim and returns coordinates.
 */
export async function geocodeConfirmedPlace(
  communeAscii: string,
  wilayaAscii: string,
): Promise<ResolvedPlace | null> {

  const commune = communes.find(
    (c) => normaliseInput(c.commune_name_ascii) === normaliseInput(communeAscii)
      && normaliseInput(c.wilaya_name_ascii) === normaliseInput(wilayaAscii)
  );

  if (!commune) return null;

  // Structured search — most accurate for known city names
  const structuredParams = new URLSearchParams({
    city:              commune.commune_name_ascii,
    state:             commune.wilaya_name_ascii,
    country:           "Algeria",
    countrycodes:      "dz",
    format:            "json",
    addressdetails:    "1",
    limit:             "5",
    "accept-language": "ar,fr,en",
  });

  try {
    let raw: any[] = await nominatimFetch(
      `${NOMINATIM_BASE}/search?${structuredParams.toString()}`
    );

    // Fallback: free-text with wilaya context
    if (raw.length === 0) {
      const fallbackParams = new URLSearchParams({
        q:                 `${commune.commune_name_ascii}, ${commune.wilaya_name_ascii}, Algeria`,
        countrycodes:      "dz",
        format:            "json",
        addressdetails:    "1",
        limit:             "5",
        "accept-language": "ar,fr,en",
      });
      raw = await nominatimFetch(
        `${NOMINATIM_BASE}/search?${fallbackParams.toString()}`
      );
    }

    // Second fallback: Arabic name
    if (raw.length === 0) {
      const arabicParams = new URLSearchParams({
        q:                 `${commune.commune_name}, ${commune.wilaya_name}`,
        countrycodes:      "dz",
        format:            "json",
        addressdetails:    "1",
        limit:             "3",
        "accept-language": "ar,fr,en",
      });
      raw = await nominatimFetch(
        `${NOMINATIM_BASE}/search?${arabicParams.toString()}`
      );
    }

    if (raw.length === 0) return null;

    // Prefer boundary/administrative results
    const best = raw.sort((a: any, b: any) => {
      const aAdmin = a.category === "boundary" ? 1 : 0;
      const bAdmin = b.category === "boundary" ? 1 : 0;
      return bAdmin - aAdmin || parseFloat(b.importance) - parseFloat(a.importance);
    })[0];

    return {
      communeNameAscii: commune.commune_name_ascii,
      communeName:      commune.commune_name,
      wilayaNameAscii:  commune.wilaya_name_ascii,
      wilayaName:       commune.wilaya_name,
      wilayaCode:       commune.wilaya_code,
      displayName:      best.display_name,
      lat:              parseFloat(best.lat),
      lon:              parseFloat(best.lon),
    };
  } catch (err: any) {
    throw new Error(`Geocoding service unavailable: ${err.message}`);
  }
}

// ─── Reverse geocode ──────────────────────────────────────────────────────────

export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<ReverseGeocodeResult | null> {
  const params = new URLSearchParams({
    lat:               String(lat),
    lon:               String(lon),
    format:            "json",
    addressdetails:    "1",
    "accept-language": "ar,fr,en",
  });

  try {
    const data = await nominatimFetch(
      `${NOMINATIM_BASE}/reverse?${params.toString()}`
    );

    // reverse returns a single object, not an array
    const result = Array.isArray(data) ? data[0] : data;
    if (!result || result.error) return null;

    return {
      displayName: result.display_name,
      address: {
        road:     result.address?.road,
        suburb:   result.address?.suburb,
        city:     result.address?.city ?? result.address?.town ?? result.address?.village,
        town:     result.address?.town,
        village:  result.address?.village,
        state:    result.address?.state,
        postcode: result.address?.postcode,
        country:  result.address?.country,
      },
      lat: parseFloat(result.lat),
      lon: parseFloat(result.lon),
    };
  } catch (err: any) {
    throw new Error(`Reverse geocoding service unavailable: ${err.message}`);
  }
}

// ─── Internal fetch helper ────────────────────────────────────────────────────

async function nominatimFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "DeliveryApp/1.0" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}