// Server-only geographic lookup. Keep the database on the geocoder's side
// of the module boundary; browser formatting needs only lib/zoneTime.
// zoneLookup.test.ts guards the client import graph against crossing it.
import "server-only";
import tzlookup from "tz-lookup";
import { DEFAULT_ZONE } from "../../lib/zoneTime";

/** lat/lng → IANA zone via an OFFLINE lookup (no API key, fits Vercel
 * serverless). Never throws: invalid coordinates retain the default. */
export function zoneFromLatLng(lat: number, lng: number): string {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return DEFAULT_ZONE;
    return tzlookup(lat, lng);
  } catch {
    return DEFAULT_ZONE;
  }
}
