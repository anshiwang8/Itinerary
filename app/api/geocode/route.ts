import { NextRequest } from "next/server";
import { isMockMode, mockGeocodingResponse } from "../_mock/fixtures";
import {
  apiError,
  apiJson,
  enforceRateLimit,
  readJsonBody,
  requestContext,
  requireServiceKey,
} from "../_shared/http";
import { fetchProvider, readProviderJson } from "../_shared/provider";
import {
  buildGeocodeUrl,
  parseGeocodeRequest,
  resolveGeocodeResponse,
} from "./geocode";

// POST /api/geocode
//   { query, kind: "city" }
//   { query, kind: "address", cityContext: <resolved city> }
//
// City and street-address lookup use Google's purpose-built Geocoding API.
// Address requests are biased to, and then objectively checked against, the
// already resolved city. A distinct server-only key keeps this service's
// permissions separate from Places and browser Maps.
export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "geocode");
  try {
    enforceRateLimit(ctx, 60);
    const geocodeRequest = parseGeocodeRequest(await readJsonBody(request));

    // Fixture seam: only provider data changes. Result validation, ambiguity
    // handling, city containment, and timezone resolution all run for real.
    const providerData = isMockMode()
      ? mockGeocodingResponse(geocodeRequest)
      : await (async () => {
          const apiKey = requireServiceKey(process.env.GOOGLE_GEOCODING_API_KEY);
          const response = await fetchProvider(
            "geocoding",
            buildGeocodeUrl(geocodeRequest, apiKey),
            { method: "GET", cache: "no-store" }
          );
          return readProviderJson("geocoding", response);
        })();

    return apiJson(
      ctx,
      resolveGeocodeResponse(providerData, geocodeRequest)
    );
  } catch (error) {
    return apiError(ctx, error);
  }
}
