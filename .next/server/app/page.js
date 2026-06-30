(()=>{var e={};e.id=931,e.ids=[931],e.modules={2934:e=>{"use strict";e.exports=require("next/dist/client/components/action-async-storage.external.js")},4580:e=>{"use strict";e.exports=require("next/dist/client/components/request-async-storage.external.js")},5869:e=>{"use strict";e.exports=require("next/dist/client/components/static-generation-async-storage.external.js")},399:e=>{"use strict";e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},2460:(e,s,i)=>{"use strict";i.r(s),i.d(s,{GlobalError:()=>d.a,__next_app__:()=>p,originalPathname:()=>v,pages:()=>c,routeModule:()=>u,tree:()=>o}),i(908),i(1506),i(5866);var a=i(3191),t=i(8716),n=i(7922),d=i.n(n),l=i(5231),r={};for(let e in l)0>["default","tree","pages","GlobalError","originalPathname","__next_app__","routeModule"].indexOf(e)&&(r[e]=()=>l[e]);i.d(s,r);let o=["",{children:["__PAGE__",{},{page:[()=>Promise.resolve().then(i.bind(i,908)),"C:\\Users\\anshi\\Desktop\\Claude Code\\itinerary\\app\\page.tsx"]}]},{layout:[()=>Promise.resolve().then(i.bind(i,1506)),"C:\\Users\\anshi\\Desktop\\Claude Code\\itinerary\\app\\layout.tsx"],"not-found":[()=>Promise.resolve().then(i.t.bind(i,5866,23)),"next/dist/client/components/not-found-error"]}],c=["C:\\Users\\anshi\\Desktop\\Claude Code\\itinerary\\app\\page.tsx"],v="/page",p={require:i,loadChunk:()=>Promise.resolve()},u=new a.AppPageRouteModule({definition:{kind:t.x.APP_PAGE,page:"/page",pathname:"/",bundlePath:"",filename:"",appPaths:[]},userland:{loaderTree:o}})},2085:()=>{},3729:(e,s,i)=>{Promise.resolve().then(i.bind(i,8743))},3639:(e,s,i)=>{Promise.resolve().then(i.t.bind(i,2994,23)),Promise.resolve().then(i.t.bind(i,6114,23)),Promise.resolve().then(i.t.bind(i,9727,23)),Promise.resolve().then(i.t.bind(i,9671,23)),Promise.resolve().then(i.t.bind(i,1868,23)),Promise.resolve().then(i.t.bind(i,4759,23))},8743:(e,s,i)=>{"use strict";i.r(s),i.d(s,{default:()=>d});var a=i(326),t=i(7577);let n=`
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
      <span class="hi"><span id="wHi">–</span>\xb0<span class="deg"> H</span></span>
      <span class="lo"><span id="wLo">–</span>\xb0<span class="deg"> L</span></span>
    </div>
  </div>
</div>

<svg id="pointerSvg"></svg>
`;function d(){let e=(0,t.useRef)(null);return a.jsx("div",{ref:e,dangerouslySetInnerHTML:{__html:n}})}},1506:(e,s,i)=>{"use strict";i.r(s),i.d(s,{default:()=>n,metadata:()=>t});var a=i(9510);i(7272);let t={title:"Itinerary — life moves simpler.",description:"Plan your day, weather included."};function n({children:e}){return a.jsx("html",{lang:"en",children:a.jsx("body",{children:e})})}},908:(e,s,i)=>{"use strict";i.r(s),i.d(s,{default:()=>a});let a=(0,i(8570).createProxy)(String.raw`C:\Users\anshi\Desktop\Claude Code\itinerary\app\page.tsx#default`)},7272:()=>{}};var s=require("../webpack-runtime.js");s.C(e);var i=e=>s(s.s=e),a=s.X(0,[819],()=>i(2460));module.exports=a})();