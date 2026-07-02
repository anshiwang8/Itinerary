"use client";

import { useEffect, useRef } from "react";
import PlacesTest from "./PlacesTest";

// The Itinerary prototype is a heavily imperative, DOM-driven UI (custom
// date picker, hand-drawn pointer SVG, staggered reveal). Rather than
// rewrite all of that into React state, we mount the original markup and
// run the original vanilla logic once on the client. The weather box is
// currently a static placeholder (live integration to be rebuilt).
const MARKUP = `
<div class="bg-base" id="bgBase"></div>
<div class="bg-weather" id="bgWeather">
  <div class="sun-big"></div>
  <div class="cloud c1"></div>
  <div class="cloud c2"></div>
  <div class="cloud c3"></div>
</div>

<nav>
  <div class="brand">Itinerary</div>
  <div class="nav-links"><a href="#">Pricing</a><a href="#">About us</a></div>
</nav>

<div class="nav-search" id="navSearch">
  <div class="seg"><label>Search</label><span class="val" id="navQ">—</span></div>
  <div class="divline"></div>
  <div class="seg"><label>Start</label><span class="val" id="navStart">—</span></div>
  <div class="divline"></div>
  <div class="seg"><label>End</label><span class="val" id="navEnd">—</span></div>
  <button class="mini-btn"><svg viewBox="0 0 24 24"><path d="M21.7 20.3l-4.9-4.9A8.3 8.3 0 1 0 15.4 16.8l4.9 4.9a1 1 0 0 0 1.4-1.4zM10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13z"/></svg></button>
</div>

<main class="hero" id="hero">
  <h1>Itinerary</h1>
  <p class="tagline">life moves simpler.</p>
  <div class="search-bar">
    <div class="bar-section search-seg">
      <label for="searchInput">Search</label>
      <input type="text" id="searchInput" placeholder="what were you thinking?" />
    </div>
    <div class="bar-divider"></div>
    <div class="bar-section" id="startSection" onclick="openPicker('start', event)">
      <label>Start Time</label>
      <div class="datetime-display" id="startDisplay">Add date</div>
    </div>
    <div class="bar-divider"></div>
    <div class="bar-section" id="endSection" onclick="openPicker('end', event)">
      <label>End Time</label>
      <div class="datetime-display" id="endDisplay">Add date</div>
    </div>
    <button class="search-btn" onclick="runSearch()" aria-label="Search">
      <svg viewBox="0 0 24 24"><path d="M21.7 20.3l-4.9-4.9A8.3 8.3 0 1 0 15.4 16.8l4.9 4.9a1 1 0 0 0 1.4-1.4zM10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13z"/></svg>
    </button>
  </div>
</main>

<div class="picker-overlay" id="pickerOverlay" onclick="overlayClick(event)">
  <div class="picker-popup" id="pickerPopup">
    <div class="picker-header">
      <button onclick="changeMonth(-1)">&#8249;</button>
      <span class="month-year" id="monthYear"></span>
      <button onclick="changeMonth(1)">&#8250;</button>
    </div>
    <div class="calendar-grid" id="calendarGrid"></div>
    <div class="time-section">
      <label>Time</label>
      <div class="time-inputs">
        <input type="number" id="hourInput" min="1" max="12" placeholder="12" />
        <span class="time-sep">:</span>
        <input type="number" id="minInput" min="0" max="59" placeholder="00" />
      </div>
      <button class="ampm-btn" id="ampmBtn" onclick="toggleAmPm()">AM</button>
    </div>
    <div class="picker-footer">
      <button class="btn-clear" onclick="clearPicker()">Clear</button>
      <button class="btn-apply" onclick="applyPicker()">Apply</button>
    </div>
  </div>
</div>

<section class="schedule-screen" id="schedule">
  <div class="rows" id="rows"></div>
  <div class="edit-zone">
    <div class="edit-bar" id="editBar">
      <span class="q">Switch out <b id="editTarget">this</b> for…</span>
      <input type="text" placeholder="what would you prefer?" />
      <button class="go"><svg viewBox="0 0 24 24"><path d="M21.7 20.3l-4.9-4.9A8.3 8.3 0 1 0 15.4 16.8l4.9 4.9a1 1 0 0 0 1.4-1.4zM10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13z"/></svg></button>
    </div>
  </div>
</section>

<div class="weather-box" id="weatherBox">
  <svg class="w-icon" id="wIcon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <circle cx="24" cy="24" r="11" fill="#ffd24d"/>
    <g stroke="#ffd24d" stroke-width="2.5" stroke-linecap="round">
      <line x1="24" y1="6" x2="24" y2="11"/>
      <line x1="24" y1="37" x2="24" y2="42"/>
      <line x1="6" y1="24" x2="11" y2="24"/>
      <line x1="9" y1="9" x2="13" y2="13"/>
      <line x1="35" y1="13" x2="39" y2="9"/>
    </g>
    <path d="M30 44a9 9 0 0 1 17.6-2.6A8 8 0 1 1 49 57H32a6.5 6.5 0 0 1-2-12.7z" fill="#eef4f7" stroke="#cfe0e6" stroke-width="1.5"/>
  </svg>
  <div class="w-text">
    <div class="cond" id="wCond">—</div>
    <div class="w-temps">
      <span class="hi"><span id="wHi">–</span>°<span class="deg"> H</span></span>
      <span class="lo"><span id="wLo">–</span>°<span class="deg"> L</span></span>
    </div>
  </div>
</div>

<svg id="pointerSvg"></svg>
`;

function initItinerary() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__itineraryInit) return;
  w.__itineraryInit = true;

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

  type PickerVal = { year: number; month: number; day: number; hour: number; min: number; ampm: string };
  let activePicker: string | null = null;
  let pickerState = { year: 0, month: 0, selectedDate: null as number | null, hour: 12, min: 0, ampm: "AM" };
  let startValue: PickerVal | null = null;
  let endValue: PickerVal | null = null;

  const $ = (id: string) => document.getElementById(id)!;

  function openPicker(which: string, e: Event) {
    e && e.stopPropagation();
    activePicker = which;
    const existing = which === "start" ? startValue : endValue;
    const now = new Date();
    pickerState = {
      year: existing ? existing.year : now.getFullYear(),
      month: existing ? existing.month : now.getMonth(),
      selectedDate: existing ? existing.day : null,
      hour: existing ? existing.hour : 12,
      min: existing ? existing.min : 0,
      ampm: existing ? existing.ampm : "AM",
    };
    const rect = $(which + "Section").getBoundingClientRect();
    const popup = $("pickerPopup");
    popup.style.top = rect.bottom + 10 + "px";
    let left = rect.left;
    if (left + 320 > window.innerWidth - 12) left = window.innerWidth - 332;
    popup.style.left = left + "px";
    $("pickerOverlay").classList.add("open");
    renderCalendar();
    syncTimeInputs();
  }
  function overlayClick(e: Event) { if (e.target === $("pickerOverlay")) closePicker(); }
  function closePicker() { $("pickerOverlay").classList.remove("open"); activePicker = null; }
  function renderCalendar() {
    const { year, month, selectedDate } = pickerState;
    $("monthYear").textContent = MONTHS[month] + " " + year;
    const grid = $("calendarGrid"); grid.innerHTML = "";
    DAYS.forEach((d) => { const el = document.createElement("div"); el.className = "cal-day-name"; el.textContent = d; grid.appendChild(el); });
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    for (let i = 0; i < firstDay; i++) { const b = document.createElement("button"); b.className = "cal-day"; b.disabled = true; grid.appendChild(b); }
    for (let d = 1; d <= daysInMonth; d++) {
      const btn = document.createElement("button"); btn.className = "cal-day"; btn.textContent = String(d);
      if (d === selectedDate) btn.classList.add("selected");
      if (d === today.getDate() && month === today.getMonth() && year === today.getFullYear()) btn.classList.add("today");
      btn.onclick = () => { pickerState.selectedDate = d; renderCalendar(); };
      grid.appendChild(btn);
    }
  }
  function changeMonth(delta: number) {
    let { year, month } = pickerState; month += delta;
    if (month < 0) { month = 11; year--; } if (month > 11) { month = 0; year++; }
    pickerState.year = year; pickerState.month = month; renderCalendar();
  }
  function syncTimeInputs() {
    ($("hourInput") as HTMLInputElement).value = String(pickerState.hour);
    ($("minInput") as HTMLInputElement).value = String(pickerState.min).padStart(2, "0");
    $("ampmBtn").textContent = pickerState.ampm;
  }
  function toggleAmPm() { pickerState.ampm = pickerState.ampm === "AM" ? "PM" : "AM"; $("ampmBtn").textContent = pickerState.ampm; }
  function applyPicker() {
    if (!pickerState.selectedDate) { closePicker(); return; }
    const h = parseInt(($("hourInput") as HTMLInputElement).value) || 12;
    const m = parseInt(($("minInput") as HTMLInputElement).value) || 0;
    const ampm = $("ampmBtn").textContent || "AM";
    const val: PickerVal = { year: pickerState.year, month: pickerState.month, day: pickerState.selectedDate, hour: h, min: m, ampm };
    const label = MONTHS[val.month].slice(0, 3) + " " + val.day + ", " + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + " " + ampm;
    if (activePicker === "start") { startValue = val; const el = $("startDisplay"); el.textContent = label; el.classList.add("has-value"); }
    else { endValue = val; const el = $("endDisplay"); el.textContent = label; el.classList.add("has-value"); }
    closePicker();
  }
  function clearPicker() {
    if (activePicker === "start") { startValue = null; const el = $("startDisplay"); el.textContent = "Add date"; el.classList.remove("has-value"); }
    else { endValue = null; const el = $("endDisplay"); el.textContent = "Add date"; el.classList.remove("has-value"); }
    closePicker();
  }

  // ── Itinerary data ──
  const ICONS: Record<string, string> = {
    bus: '<svg viewBox="0 0 24 24"><path d="M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z"/></svg>',
    subway: '<svg viewBox="0 0 24 24"><path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5V21h2.23l2-2h3.54l2 2H18v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17A1.5 1.5 0 1 1 9 15.5 1.5 1.5 0 0 1 7.5 17zM11 10H6V6h5v4zm2 0V6h5v4h-5zm3.5 7a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5z"/></svg>',
  };
  type Item =
    | { type: "transport"; name: string; icon: string; meta: string; sub: string; times: string; price: string }
    | { type: "destination"; name: string; rating: number; price: string; desc: string };
  const items: Item[] = [
    { type: "transport", name: "Bus 91", icon: "bus", meta: "Bus · 1h 15m", sub: "Bayview Ave & Taylor Mills Dr S → Finch Station", times: "2:35 board · 3:50 arrive", price: "$4.50" },
    { type: "transport", name: "Subway", icon: "subway", meta: "Subway · 35m", sub: "Finch Station → Union Station", times: "3:55 board · 4:30 arrive", price: "Free Transfer" },
    { type: "destination", name: "Scotiabank Arena", rating: 4.5, price: "$30", desc: "Leafs Game" },
  ];
  const PER_ROW = 3;

  function starSvg(fill: string) {
    const id = "g" + Math.random().toString(36).slice(2, 8);
    if (fill === "half") return `<svg viewBox="0 0 24 24"><defs><linearGradient id="${id}"><stop offset="50%" stop-color="#f5c518"/><stop offset="50%" stop-color="#dfe7ea"/></linearGradient></defs><path fill="url(#${id})" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
    const paint = fill === "empty" ? "#dfe7ea" : "#f5c518";
    return `<svg viewBox="0 0 24 24"><path fill="${paint}" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  }
  function renderStars(rating: number) {
    let html = "";
    for (let i = 1; i <= 5; i++) html += rating >= i ? starSvg("full") : rating >= i - 0.5 ? starSvg("half") : starSvg("empty");
    return `<span class="stars">${html}</span>`;
  }
  function cardHtml(item: Item, idx: number) {
    if (item.type === "transport") {
      return `<div class="card transport" data-idx="${idx}" onclick="selectCard(${idx})">
        <div class="t-icon">${ICONS[item.icon]}</div>
        <div class="title">${item.name}</div>
        <div class="meta">${item.meta}</div>
        <div class="sub">${item.sub}</div>
        <div class="sub" style="margin-top:6px">${item.times}</div>
        <div class="price-tag">${item.price}</div>
      </div>`;
    }
    return `<div class="card destination" data-idx="${idx}" onclick="selectCard(${idx})">
      <div class="dest-photo"><div class="sun"></div><div class="hill"></div></div>
      <div class="dest-body">
        <div class="title">${item.name}</div>
        <div class="rating">${renderStars(item.rating)}<span class="num">${item.rating.toFixed(1)}</span><span class="price">· ${item.price}</span></div>
        <div class="desc">${item.desc}</div>
      </div>
    </div>`;
  }
  function buildSchedule() {
    const rows = $("rows"); rows.innerHTML = "";
    for (let r = 0; r * PER_ROW < items.length; r++) {
      const slice = items.slice(r * PER_ROW, r * PER_ROW + PER_ROW);
      const reverse = r % 2 === 1;
      const row = document.createElement("div"); row.className = "sched-row";
      row.style.flexDirection = reverse ? "row-reverse" : "row";
      slice.forEach((item, i) => {
        const globalIdx = r * PER_ROW + i;
        const wrap = document.createElement("div"); wrap.style.display = "contents";
        wrap.innerHTML = cardHtml(item, globalIdx);
        row.appendChild(wrap.firstElementChild!);
        if (i < slice.length - 1) { const c = document.createElement("div"); c.className = "connector-h " + (reverse ? "dir-left" : "dir-right"); row.appendChild(c); }
      });
      rows.appendChild(row);
      if ((r + 1) * PER_ROW < items.length) {
        const gap = document.createElement("div"); gap.className = "row-gap";
        gap.style.justifyContent = reverse ? "flex-start" : "flex-end";
        gap.style.paddingRight = reverse ? "0" : "104px";
        gap.style.paddingLeft = reverse ? "104px" : "0";
        const v = document.createElement("div"); v.className = "connector-v dir-down"; gap.appendChild(v);
        rows.appendChild(gap);
      }
    }
  }

  function fmt(v: PickerVal) {
    return MONTHS[v.month].slice(0, 3) + " " + v.day + ", " + String(v.hour).padStart(2, "0") + ":" + String(v.min).padStart(2, "0") + " " + v.ampm;
  }

  function runSearch() {
    const q = ($("searchInput") as HTMLInputElement).value.trim();
    if (!q || !startValue || !endValue) { alert("Enter a search and pick both start and end dates to build your itinerary."); return; }
    $("navQ").textContent = q;
    $("navStart").textContent = fmt(startValue);
    $("navEnd").textContent = fmt(endValue);
    buildSchedule();
    $("hero").classList.add("lift");
    setTimeout(() => {
      $("hero").style.display = "none";
      $("schedule").classList.add("show");
      $("navSearch").classList.add("show");
      $("bgWeather").classList.add("show");
      $("bgBase").style.opacity = "0";
      $("weatherBox").classList.add("show");
      document.querySelectorAll(".card").forEach((c, i) => setTimeout(() => c.classList.add("in"), 120 + i * 130));
    }, 480);
  }

  // ── Card selection ──
  let activeIdx: number | null = null;
  function selectCard(idx: number) {
    if (activeIdx === idx) { closeEdit(); return; }
    activeIdx = idx;
    document.querySelectorAll(".card").forEach((c) => c.classList.toggle("active", Number((c as HTMLElement).dataset.idx) === idx));
    $("editTarget").textContent = items[idx].name;
    $("editBar").classList.add("show");
    requestAnimationFrame(() => requestAnimationFrame(drawPointer));
  }
  function closeEdit() {
    activeIdx = null;
    document.querySelectorAll(".card").forEach((c) => c.classList.remove("active"));
    $("editBar").classList.remove("show");
    $("pointerSvg").innerHTML = "";
  }
  function drawPointer() {
    const svg = $("pointerSvg"); svg.innerHTML = "";
    if (activeIdx === null) return;
    const card = document.querySelector(`.card[data-idx="${activeIdx}"]`);
    const bar = $("editBar");
    if (!card || !bar.classList.contains("show")) return;
    const cr = card.getBoundingClientRect(), br = bar.getBoundingClientRect();
    const x1 = br.left + br.width / 2, y1 = br.top;
    const x2 = cr.left + cr.width / 2, y2 = cr.bottom;
    const my = (y1 + y2) / 2;
    svg.innerHTML = `<path d="M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" fill="none" stroke="#6fc3d6" stroke-width="2" stroke-dasharray="6 6" opacity="0.8"/><circle cx="${x2}" cy="${y2}" r="4" fill="#6fc3d6"/>`;
  }

  // Expose handlers referenced by inline onclick attributes.
  Object.assign(w, { openPicker, runSearch, overlayClick, changeMonth, toggleAmPm, applyPicker, clearPicker, selectCard });

  window.addEventListener("resize", drawPointer);
  window.addEventListener("scroll", drawPointer, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePicker(); closeEdit(); } });
  $("searchInput").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") runSearch(); });
}

export default function Home() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initItinerary();
  }, []);

  return (
    <>
      <div ref={ref} dangerouslySetInnerHTML={{ __html: MARKUP }} />
      {/* Temporary Places API test harness — remove after verification. */}
      <PlacesTest />
    </>
  );
}
