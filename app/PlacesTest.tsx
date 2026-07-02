"use client";

import { useState } from "react";

// Throwaway harness proving the parse → places pipeline works end to
// end: one button runs /api/parse, then feeds the result straight into
// /api/places/search and renders the per-category candidate pools.
// Plain list, no styling polish — delete once real UI exists.

interface Place {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: string;
  currentOpeningHours?: { openNow?: boolean };
  businessStatus?: string;
}

type GroupedPlaces = Record<string, Place[]>;

export default function PlacesTest() {
  const [prompt, setPrompt] = useState("");
  const [parsed, setParsed] = useState<string | null>(null);
  const [grouped, setGrouped] = useState<GroupedPlaces | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "parsing" | "searching">("idle");

  async function runPipeline() {
    setError(null);
    setParsed(null);
    setGrouped(null);
    try {
      setStage("parsing");
      const parseRes = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const parseData = await parseRes.json();
      if (!parseRes.ok) {
        throw new Error(
          (parseData.error ?? `parse HTTP ${parseRes.status}`) +
            (parseData.raw ? `\nraw: ${parseData.raw}` : "")
        );
      }
      setParsed(JSON.stringify(parseData, null, 2));

      setStage("searching");
      const placesRes = await fetch("/api/places/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsed: parseData }),
      });
      const placesData = await placesRes.json();
      if (!placesRes.ok) {
        throw new Error(
          (placesData.error ?? `places HTTP ${placesRes.status}`) +
            (placesData.details ? `\ndetails: ${placesData.details}` : "")
        );
      }
      // Drop non-category keys (e.g. _hoursDebug) — only real category
      // pools should render as venue sections.
      const { _hoursDebug, ...categories } = placesData;
      setGrouped(categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStage("idle");
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
        maxWidth: 380,
        maxHeight: "70vh",
        overflowY: "auto",
        fontSize: 13,
      }}
    >
      <input
        type="text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") runPipeline(); }}
        placeholder="e.g. chill coffee afternoon for two"
        style={{ width: "100%", marginBottom: 6, padding: 4 }}
      />
      <button onClick={runPipeline} disabled={stage !== "idle" || !prompt.trim()}>
        {stage === "parsing"
          ? "Parsing…"
          : stage === "searching"
          ? "Searching places…"
          : "Test Parse → Places"}
      </button>

      {error && (
        <pre style={{ color: "#b00", whiteSpace: "pre-wrap", marginTop: 6 }}>
          Error: {error}
        </pre>
      )}

      {parsed && (
        <>
          <div style={{ marginTop: 8, fontWeight: 600 }}>Parsed</div>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{parsed}</pre>
        </>
      )}

      {grouped &&
        Object.entries(grouped).map(([category, places]) => (
          <div key={category} style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600 }}>
              {category} ({places.length})
            </div>
            {places.length === 0 && <p>No places returned.</p>}
            <ul style={{ paddingLeft: 18, marginTop: 4 }}>
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
          </div>
        ))}
    </div>
  );
}
