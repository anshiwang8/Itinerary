"use client";

import { useState } from "react";

// Throwaway harness proving the /api/places/search connection works.
// Plain list, no styling polish — delete once real Places UI exists.

interface Place {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: string;
  currentOpeningHours?: { openNow?: boolean };
  businessStatus?: string;
}

export default function PlacesTest() {
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [parsePrompt, setParsePrompt] = useState("");
  const [parseResult, setParseResult] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseLoading, setParseLoading] = useState(false);

  async function runTest() {
    setLoading(true);
    setError(null);
    setPlaces(null);
    try {
      const res = await fetch("/api/places/search");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPlaces(data.places ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function runParse() {
    setParseLoading(true);
    setParseError(null);
    setParseResult(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: parsePrompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          (data.error ?? `HTTP ${res.status}`) +
            (data.raw ? `\nraw: ${data.raw}` : "")
        );
      }
      setParseResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setParseLoading(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 200,
        background: "rgba(255,255,255,0.95)",
        border: "1px solid #ccc",
        borderRadius: 10,
        padding: 12,
        maxWidth: 340,
        maxHeight: "60vh",
        overflowY: "auto",
        fontSize: 13,
      }}
    >
      <button onClick={runTest} disabled={loading}>
        {loading ? "Loading…" : "Test Places API"}
      </button>
      {error && <p style={{ color: "#b00" }}>Error: {error}</p>}
      {places && places.length === 0 && <p>No places returned.</p>}
      {places && places.length > 0 && (
        <ul style={{ paddingLeft: 18, marginTop: 8 }}>
          {places.map((p) => (
            <li key={p.id} style={{ marginBottom: 6 }}>
              <strong>{p.displayName?.text ?? "(unnamed)"}</strong>
              <br />
              rating: {p.rating ?? "n/a"} · price: {p.priceLevel ?? "n/a"}
              <br />
              {p.currentOpeningHours?.openNow == null
                ? "open now: n/a"
                : p.currentOpeningHours.openNow
                ? "open now"
                : "closed now"}{" "}
              · {p.businessStatus ?? "status n/a"}
            </li>
          ))}
        </ul>
      )}

      <hr style={{ margin: "10px 0" }} />

      <input
        type="text"
        value={parsePrompt}
        onChange={(e) => setParsePrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") runParse(); }}
        placeholder="e.g. chill coffee afternoon for two"
        style={{ width: "100%", marginBottom: 6, padding: 4 }}
      />
      <button onClick={runParse} disabled={parseLoading || !parsePrompt.trim()}>
        {parseLoading ? "Parsing…" : "Test Parse"}
      </button>
      {parseError && (
        <pre style={{ color: "#b00", whiteSpace: "pre-wrap", marginTop: 6 }}>
          Error: {parseError}
        </pre>
      )}
      {parseResult && (
        <pre style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{parseResult}</pre>
      )}
    </div>
  );
}
