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

interface DropEntry {
  category: string;
  name: string;
  id: string;
  rule: string;
  detail: string;
}

interface Selection {
  category: string;
  id: string | null;
  reason: string;
  fallback?: boolean;
  name?: string;
  rating?: number;
}

export default function PlacesTest() {
  const [prompt, setPrompt] = useState("");
  const [parsed, setParsed] = useState<string | null>(null);
  const [grouped, setGrouped] = useState<GroupedPlaces | null>(null);
  const [dropLog, setDropLog] = useState<DropEntry[]>([]);
  const [selections, setSelections] = useState<Selection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<
    "idle" | "parsing" | "searching" | "selecting"
  >("idle");

  async function runPipeline() {
    setError(null);
    setParsed(null);
    setGrouped(null);
    setDropLog([]);
    setSelections(null);
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
      // Split the drop log off the response — only real category pools
      // render as venue sections.
      const { _dropLog, ...categories } = placesData;
      setDropLog(Array.isArray(_dropLog) ? _dropLog : []);
      setGrouped(categories);

      setStage("selecting");
      const selectRes = await fetch("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsed: parseData, pools: categories }),
      });
      const selectData = await selectRes.json();
      if (!selectRes.ok) {
        throw new Error(
          (selectData.error ?? `select HTTP ${selectRes.status}`) +
            (selectData.raw ? `\nraw: ${selectData.raw}` : "")
        );
      }
      setSelections(selectData.selections ?? []);
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
          : stage === "selecting"
          ? "Selecting venues…"
          : "Test Parse → Places → Select"}
      </button>

      {selections && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Final picks</div>
          {selections.map((s) => (
            <div
              key={s.category}
              style={{
                marginTop: 6,
                padding: "8px 10px",
                border: "1px solid #d5e5ea",
                borderRadius: 8,
                background: "#f6fbfc",
              }}
            >
              <div style={{ fontSize: 11, textTransform: "uppercase", color: "#679" }}>
                {s.category}
                {s.fallback && " · fallback"}
              </div>
              {s.id === null ? (
                <em>{s.reason}</em>
              ) : (
                <>
                  <strong>{s.name}</strong>
                  {s.rating != null && <> · {s.rating}★</>}
                  <div style={{ color: "#557", marginTop: 2 }}>{s.reason}</div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <pre style={{ color: "#b00", whiteSpace: "pre-wrap", marginTop: 6 }}>
          Error: {error}
        </pre>
      )}

      {parsed && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontWeight: 600 }}>Parsed</summary>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{parsed}</pre>
        </details>
      )}

      {grouped &&
        Object.entries(grouped).map(([category, places]) => {
          const drops = dropLog.filter((d) => d.category === category);
          return (
            <div key={category} style={{ marginTop: 8 }}>
              <details>
                <summary style={{ fontWeight: 600 }}>
                  {category} — {places.length} surviving
                </summary>
                {places.length === 0 && <p>No places survived the filter.</p>}
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
              </details>
              <details style={{ marginTop: 2, color: "#777" }}>
                <summary>dropped ({drops.length})</summary>
                <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                  {drops.map((d, i) => (
                    <li key={`${d.id}-${i}`}>
                      {d.name} — <em>{d.rule}</em> ({d.detail})
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          );
        })}
    </div>
  );
}
