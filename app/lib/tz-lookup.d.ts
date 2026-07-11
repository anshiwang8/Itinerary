// tz-lookup ships no types. It's a single default export: (lat, lng) → IANA.
declare module "tz-lookup" {
  export default function tzlookup(latitude: number, longitude: number): string;
}
