/************************************
 * Helpers
 ************************************/
const norm = (s) => (s || "").toString().trim().toUpperCase();

function $(id) { return document.getElementById(id); }

function cloneTpl(id) {
  const tpl = $(id);
  if (!tpl) throw new Error(`Missing template: ${id}`);
  return tpl.content.firstElementChild.cloneNode(true);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function setLoadingState(loading) {
  const list = $("airport-list");
  if (!list) return;
  
  if (loading) {
    list.classList.add("loading");
    if (list.children.length === 0) {
      list.textContent = "Loading weather data...";
    }
  } else {
    list.classList.remove("loading");
  }
}

function showError(message) {
  const list = $("airport-list");
  if (list) {
    const errorDiv = document.createElement("div");
    errorDiv.className = "error-message";
    // textContent automatically escapes, so no need for escapeHtml
    errorDiv.textContent = `Error: ${message}`;
    list.replaceChildren(errorDiv);
  }
}

/************************************
 * Cache config (client)
 ************************************/
const STORAGE_KEY = "rwjStationsV1";
const DATA_CACHE_KEY = "rwjDataCacheV1";
const DATA_TTL_MS = 10 * 60 * 1000; // 10 minutes
const IFR_LOOKAHEAD_HOURS = 6;

const AGE_FRESH_MIN = 30;
const AGE_STALE_MIN = 90;

/************************************
 * Defaults + user airports
 ************************************/
const DEFAULT_STATIONS = [
  { id: "KMJX", name: "Ocean County Airport" },
  { id: "KWRI", name: "McGuire" },
  { id: "KACY", name: "Atlantic City" },
  { id: "KSMQ", name: "Somerset" },
  { id: "KPHL", name: "Philadelphia" }
];

function loadStationsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATIONS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_STATIONS;

    return parsed
      .map(s => ({ id: norm(s.id), name: (s.name || norm(s.id)) }))
      .filter(s => s.id && s.id.length >= 3);
  } catch {
    return DEFAULT_STATIONS;
  }
}

function saveStationsToStorage(sts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sts));
  // Airports list changed => invalidate data cache so next render fetches fresh
  localStorage.removeItem(DATA_CACHE_KEY);
}

let stations = loadStationsFromStorage();

/************************************
 * TAF overrides
 ************************************/
const tafOverride = {
  KMJX: "KWRI",
  KSMQ: "KTTN"
};

/************************************
 * ASOS fallback config
 ************************************/
const ASOS_NETWORK = "NJ_ASOS";
const toAsosId = (icao) => {
  const s = norm(icao);
  return s.startsWith("K") && s.length === 4 ? s.slice(1) : s;
};

/************************************
 * Expand/collapse state
 ************************************/
let pinnedOpenId = norm(stations[0]?.id);
const expandedSet = new Set([pinnedOpenId]);

function applyExpandedState(cardEl, id) {
  const nid = norm(id);
  const isPinned = nid === pinnedOpenId;
  const isExpanded = isPinned || expandedSet.has(nid);

  cardEl.classList.toggle("expanded", isExpanded);
  cardEl.classList.toggle("pinned", isPinned);

  const titleEl = cardEl.querySelector("h2.js-name");
  if (titleEl) titleEl.setAttribute("aria-expanded", String(isExpanded));
}

function toggleCard(id) {
  const nid = norm(id);
  if (nid === pinnedOpenId) return;

  if (expandedSet.has(nid)) expandedSet.delete(nid);
  else expandedSet.add(nid);
}

/************************************
 * Date / Time display
 ************************************/
function updateTime() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const el = $("datetime");
  if (el) el.textContent = `${date} ${time}`;
}
updateTime();
setInterval(updateTime, 60000);

/************************************
 * Age display
 ************************************/
function minutesSince(isoString) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((Date.now() - t) / 60000);
  return Number.isFinite(mins) ? mins : null;
}

function formatAgeText(mins) {
  if (mins == null) return "—";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ago`;
}


/************************************
 * Obs helpers
 ************************************/
function parseVisibility(visib) {
  if (typeof visib === "number") return visib;
  if (typeof visib === "string") {
    const n = parseFloat(visib.replace("+", ""));
    return Number.isFinite(n) ? n : 10;
  }
  return 10;
}

function ceilingFromMetarClouds(clouds = []) {
  const ceilings = (clouds || [])
    .filter(l => l && (l.cover === "BKN" || l.cover === "OVC" || l.cover === "VV"))
    .map(l => l.base)
    .filter(v => typeof v === "number" && Number.isFinite(v));
  return ceilings.length ? Math.min(...ceilings) : null;
}

function ceilingFromAsos(asosRow) {
  if (!asosRow) return null;

  const pairs = [
    { cover: asosRow.skyc1, base: asosRow.skyl1 },
    { cover: asosRow.skyc2, base: asosRow.skyl2 },
    { cover: asosRow.skyc3, base: asosRow.skyl3 },
    { cover: asosRow.skyc4, base: asosRow.skyl4 }
  ];

  const ceilings = pairs
    .filter(p => typeof p.base === "number" && Number.isFinite(p.base) && p.base > 0)
    .filter(p => {
      const c = (p.cover || "").toString().trim().toUpperCase();
      return c === "BKN" || c === "OVC" || c === "VV";
    })
    .map(p => p.base);

  return ceilings.length ? Math.min(...ceilings) : null;
}

function flightCategoryFromObs(visSm, ceilFt) {
  if (visSm < 1 || ceilFt < 500) return "lifr";
  if (visSm < 3 || ceilFt < 1000) return "ifr";
  if (visSm < 5 || ceilFt < 3000) return "mvfr";
  return "vfr";
}

/************************************
 * Timeline rendering
 ************************************/
function formatHour(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  return `${hh}:00`;
}

function renderTimelineInto(containerEl, timeline) {
  if (!containerEl) {
    console.warn("renderTimelineInto: containerEl is null");
    return;
  }
  
  containerEl.replaceChildren();

  if (!timeline || timeline.length === 0) {
    containerEl.appendChild(cloneTpl("tpl-no-taf"));
    return;
  }

  const timelineEl = cloneTpl("tpl-timeline");

  for (const h of timeline) {
    const tickEl = cloneTpl("tpl-tick");
    const hour = formatHour(h.hourIso);
    const cat = (h.cat || "unk").toLowerCase();
    const label = cat === "unk" ? "UNK" : cat.toUpperCase();

    tickEl.querySelector(".tick-hour").textContent = hour;

    const catEl = tickEl.querySelector(".tick-cat");
    catEl.textContent = label;
    catEl.classList.add(cat);

    // Build tooltip with detailed information for this specific hour
    const tooltipParts = [];
    
    // Visibility
    if (typeof h.vis === "number") {
      const visText = h.vis % 1 === 0 ? h.vis.toFixed(0) : h.vis.toFixed(1);
      tooltipParts.push(`Visibility: ${visText}sm`);
    } else {
      tooltipParts.push("Visibility: —");
    }
    
    // Ceiling
    if (typeof h.ceil === "number") {
      tooltipParts.push(`Ceiling: ${h.ceil.toLocaleString()}ft`);
    } else {
      tooltipParts.push("Ceiling: —");
    }
    
    // Wind
    if (typeof h.windSpeed === "number" || typeof h.windGust === "number") {
      const windParts = [];
      if (typeof h.windDir === "number") {
        windParts.push(`${h.windDir}°`);
      }
      if (typeof h.windSpeed === "number") {
        windParts.push(`${h.windSpeed}kt`);
      } else {
        windParts.push("—kt");
      }
      if (typeof h.windGust === "number") {
        windParts.push(`G${h.windGust}kt`);
      }
      tooltipParts.push(`Wind: ${windParts.join(" ")}`);
    } else {
      tooltipParts.push("Wind: —");
    }

    // Set tooltip on the tick element
    tickEl.title = tooltipParts.join("\n");
    timelineEl.appendChild(tickEl);
  }

  containerEl.appendChild(timelineEl);
}

/************************************
 * Alerts
 ************************************/
function findFirstIfrHour(timeline, lookaheadHours = 6) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  const subset = timeline.slice(0, lookaheadHours);
  for (const h of subset) {
    const cat = (h.cat || "").toLowerCase();
    if (cat === "ifr" || cat === "lifr") return h;
  }
  return null;
}

function renderAlerts(alerts) {
  const el = $("alert-banner");
  if (!el) return;

  el.replaceChildren();

  if (!alerts.length) {
    return;
  }

  alerts.forEach(a => {
    const alertDiv = document.createElement("div");
    // className doesn't need escaping - just use the category directly
    alertDiv.className = `alert ${a.cat}`;
    
    const msgDiv = document.createElement("div");
    msgDiv.className = "msg";
    
    const srcDiv = document.createElement("div");
    srcDiv.className = "src";

    if (a.type === "now") {
      // textContent automatically escapes, so no need for escapeHtml
      msgDiv.textContent = `${a.name}: ${a.cat.toUpperCase()} now`;
      srcDiv.textContent = "METAR";
    } else {
      const hh = String(new Date(a.hourIso).getHours()).padStart(2, "0");
      msgDiv.textContent = `${a.name}: ${a.cat.toUpperCase()} expected by ${hh}:00`;
      srcDiv.textContent = "TAF";
    }

    alertDiv.appendChild(msgDiv);
    alertDiv.appendChild(srcDiv);
    el.appendChild(alertDiv);
  });
}

/************************************
 * Airports UI (manage)
 ************************************/
function addStation(id, name = "") {
  const nid = norm(id);
  if (!nid) return;
  if (stations.some(s => norm(s.id) === nid)) return;

  stations.push({ id: nid, name: name.trim() || nid });
  saveStationsToStorage(stations);

  // if it's the first added and list was empty, re-pin
  pinnedOpenId = norm(stations[0]?.id);
  expandedSet.add(pinnedOpenId);
}

function removeStation(id) {
  const nid = norm(id);
  stations = stations.filter(s => norm(s.id) !== nid);
  
  // Prevent removing all stations
  if (stations.length === 0) {
    stations = [...DEFAULT_STATIONS];
  }
  
  saveStationsToStorage(stations);

  // If they removed the pinned station, re-pin to the new top
  pinnedOpenId = norm(stations[0]?.id);
  expandedSet.clear();
  if (pinnedOpenId) {
    expandedSet.add(pinnedOpenId);
  }
}

let managePanelListeners = [];

function renderManagePanel() {
  const panel = $("manage-panel");
  if (!panel) return;

  // Remove old event listeners to prevent memory leaks
  managePanelListeners.forEach(({ element, event, handler }) => {
    element.removeEventListener(event, handler);
  });
  managePanelListeners = [];

  // Clear and rebuild using DOM methods (safer than innerHTML)
  panel.replaceChildren();

  const titleDiv = document.createElement("div");
  titleDiv.className = "manage-title";
  titleDiv.textContent = "Your Airports";
  panel.appendChild(titleDiv);

  stations.forEach(s => {
    const rowDiv = document.createElement("div");
    rowDiv.className = "manage-row";

    const infoDiv = document.createElement("div");
    const bold = document.createElement("b");
    bold.textContent = norm(s.id);
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = ` ${s.name}`;
    infoDiv.appendChild(bold);
    infoDiv.appendChild(span);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "Remove";
    removeBtn.dataset.id = norm(s.id);

    const handler = async () => {
      removeStation(removeBtn.dataset.id);
      renderManagePanel();
      await refreshWeather(true);
    };
    removeBtn.addEventListener("click", handler);
    managePanelListeners.push({ element: removeBtn, event: "click", handler });

    rowDiv.appendChild(infoDiv);
    rowDiv.appendChild(removeBtn);
    panel.appendChild(rowDiv);
  });
}

function initControls() {
  const input = $("airport-input");
  const addBtn = $("btn-add");
  const manageBtn = $("btn-manage");
  const clearCacheBtn = $("btn-clear-cache");
  const panel = $("manage-panel");

  addBtn?.addEventListener("click", async () => {
    const val = input.value;
    if (!val) return;
    addStation(val);
    input.value = "";
    renderManagePanel();
    // Refresh to get METAR data which will update the airport name
    await refreshWeather(true);
  });

  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn.click();
  });

  manageBtn?.addEventListener("click", () => {
    panel.classList.toggle("hidden");
    renderManagePanel();
  });

  clearCacheBtn?.addEventListener("click", async () => {
    if (confirm("Clear weather data cache? This will force a fresh fetch of all weather data.")) {
      localStorage.removeItem(DATA_CACHE_KEY);
      await refreshWeather(true);
    }
  });
}

/************************************
 * Client data cache
 ************************************/
function loadCachedData() {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.savedAt !== "number" || !obj.payload) return null;
    if (Date.now() - obj.savedAt > DATA_TTL_MS) return null;
    return obj.payload;
  } catch {
    return null;
  }
}

function saveCachedData(payload) {
  localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({
    savedAt: Date.now(),
    payload
  }));
}

function isCacheStale() {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY);
    if (!raw) return true;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.savedAt !== "number") return true;
    return (Date.now() - obj.savedAt) > DATA_TTL_MS;
  } catch {
    return true;
  }
}

/************************************
 * Fetch data from server (one shot)
 ************************************/
function buildTafIds() {
  const ids = new Set(stations.map(s => norm(s.id)));
  for (const v of Object.values(tafOverride)) ids.add(norm(v));
  return Array.from(ids).join(",");
}

async function fetchAirportsData(signal = null) {
  // Handle empty stations array
  if (!stations || stations.length === 0) {
    return {
      fetchedAt: new Date().toISOString(),
      metars: [],
      tafData: [],
      asosRows: []
    };
  }

  const metarIds = stations.map(s => norm(s.id)).join(",");
  const tafIds = buildTafIds();
  const asosStations = Array.from(new Set(stations.map(s => toAsosId(s.id)))).join(",");

  const fetchOptions = signal ? { signal } : {};

  const [metarRes, tafRes, asosRes] = await Promise.all([
    fetch(`/api/metar?ids=${encodeURIComponent(metarIds)}`, fetchOptions),
    fetch(`/api/tafTimeline?ids=${encodeURIComponent(tafIds)}&hours=24`, fetchOptions),
    fetch(`/api/asosLatest?network=${encodeURIComponent(ASOS_NETWORK)}&stations=${encodeURIComponent(asosStations)}`, fetchOptions)
  ]);

  if (!metarRes.ok) {
    const text = await metarRes.text().catch(() => "");
    throw new Error(`METAR fetch failed (${metarRes.status}): ${text.slice(0, 120)}`);
  }
  if (!tafRes.ok) {
    const t = await tafRes.text().catch(() => "");
    throw new Error(`TAF timeline fetch failed (${tafRes.status}): ${t.slice(0, 120)}`);
  }
  if (!asosRes.ok) {
    const text = await asosRes.text().catch(() => "");
    throw new Error(`ASOS fetch failed (${asosRes.status}): ${text.slice(0, 120)}`);
  }

  let metars, tafData, asosRows;
  try {
    [metars, tafData, asosRows] = await Promise.all([
      metarRes.json(),
      tafRes.json(),
      asosRes.json()
    ]);
  } catch (err) {
    throw new Error(`Failed to parse response: ${err.message}`);
  }

  return {
    fetchedAt: new Date().toISOString(),
    metars: Array.isArray(metars) ? metars : [],
    tafData: Array.isArray(tafData) ? tafData : [],
    asosRows: Array.isArray(asosRows) ? asosRows : []
  };
}

/************************************
 * Render from payload (no fetch)
 ************************************/
function renderFromPayload(payload) {
  const list = $("airport-list");
  if (!list) return;

  const metarMap = new Map((payload.metars || []).map(m => [norm(m.icaoId), m]));
  // Build TAF map - ensure icaoId is normalized and timeline is always an array
  const tafMap = new Map((payload.tafData || []).map(t => {
    const key = norm(t.icaoId || t.stationId || t.station || "");
    const timeline = Array.isArray(t.timeline) ? t.timeline : [];
    return [key, timeline];
  }).filter(([key]) => key)); // Filter out entries with empty keys
  const asosMap = new Map((payload.asosRows || []).map(r => [norm(r.station), r]));

  // Helper function to clean airport names (remove state/country suffixes)
  function cleanAirportName(name) {
    if (!name || typeof name !== "string") return name;
    // Remove common patterns: ", STATE", ", Country", ", USA", etc.
    return name
      .replace(/,\s*[A-Z]{2}\s*$/, "") // Remove ", NY", ", CA", etc.
      .replace(/,\s*United States\s*$/i, "") // Remove ", United States"
      .replace(/,\s*USA\s*$/i, "") // Remove ", USA"
      .replace(/,\s*US\s*$/i, "") // Remove ", US"
      .trim();
  }

  // Airport name lookup table (fallback if METAR doesn't provide names)
  const airportNameLookup = {
    "KMJX": "Ocean County Airport",
    "KWRI": "McGuire",
    "KACY": "Atlantic City",
    "KBLM": "Belmar / Monmouth",
    "KNEL": "Lakehurst NAS",
    "KSMQ": "Somerset",
    "KPHL": "Philadelphia International Airport",
    "KTTN": "Trenton",
    "KEWR": "Newark Liberty International Airport",
    "KLGA": "LaGuardia Airport",
    "KJFK": "John F. Kennedy International Airport",
    "KMMU": "Morristown",
    "KN07": "Lincoln Park",
    "KCDW": "Essex County",
    "K12N": "Andover",
    "KN40": "South Jersey Regional",
    "KILG": "Wilmington",
    "KRDG": "Reading",
    "KABE": "Allentown",
    "KMDT": "Harrisburg",
    "KIPT": "Williamsport",
    "KAVP": "Wilkes-Barre/Scranton",
    "KERI": "Erie",
    "KBWI": "Baltimore/Washington International",
    "KDCA": "Ronald Reagan Washington National",
    "KIAD": "Washington Dulles International"
  };

  // Update station names from METAR data or lookup table
  let stationsUpdated = false;
  stations.forEach(st => {
    const stKey = norm(st.id);
    let airportName = null;
    
    // First try METAR data
    const metar = metarMap.get(stKey);
    if (metar) {
      // Try multiple possible name fields from METAR response
      airportName = metar.name || 
                   metar.stationName || 
                   metar.site || 
                   metar.airport || 
                   metar.facilityName ||
                   null;
    }
    
    // Fallback to lookup table if METAR doesn't have name
    if (!airportName) {
      airportName = airportNameLookup[stKey] || null;
    }
    
    // Only update if name is still the ICAO code (not manually set by user)
    if (airportName && typeof airportName === "string" && airportName.trim()) {
      const cleanedName = cleanAirportName(airportName);
      // Update if current name matches the ICAO code
      if (norm(st.name) === stKey || st.name === stKey) {
        st.name = cleanedName;
        stationsUpdated = true;
      }
    }
  });
  if (stationsUpdated) {
    saveStationsToStorage(stations);
  }

  list.replaceChildren();

  const alerts = [];

  stations.forEach((st) => {
    if (!st || !st.id) return; // Skip invalid stations
    
    const stKey = norm(st.id);
    const metar = metarMap.get(stKey) || null;
    const asos = asosMap.get(norm(toAsosId(st.id))) || null;

    // timeline with overrides
    // Check if this station has a TAF override (e.g., KMJX uses KWRI's TAF)
    const overrideTarget = tafOverride[stKey];
    let timeline = [];
    
    if (overrideTarget) {
      // Station has an override - try to get the override target's TAF
      const overrideKey = norm(overrideTarget);
      const overrideTimeline = tafMap.get(overrideKey);
      if (Array.isArray(overrideTimeline) && overrideTimeline.length > 0) {
        timeline = overrideTimeline;
      } else {
        // Override target not found or empty - try station's own TAF as fallback
        const ownTimeline = tafMap.get(stKey);
        if (Array.isArray(ownTimeline) && ownTimeline.length > 0) {
          timeline = ownTimeline;
        }
      }
    } else {
      // No override - use station's own TAF
      const ownTimeline = tafMap.get(stKey);
      if (Array.isArray(ownTimeline)) {
        timeline = ownTimeline;
      }
    }
    
    // Ensure timeline is always an array
    if (!Array.isArray(timeline)) timeline = [];

    // card
    const card = cloneTpl("tpl-airport-card");
    card.setAttribute("data-airport-id", stKey);

    const titleEl = card.querySelector(".js-name");
    // Clear any existing content
    titleEl.textContent = "";
    // Add airport name
    const nameSpan = document.createElement("span");
    nameSpan.textContent = st.name;
    titleEl.appendChild(nameSpan);
    // Add chevron icon
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.innerHTML = "▼";
    titleEl.appendChild(chevron);
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");

    const onToggle = () => {
      toggleCard(stKey);
      applyExpandedState(card, stKey);
    };

    titleEl.addEventListener("click", onToggle);
    titleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onToggle();
      }
    });

    // obs selection: METAR -> ASOS fallback
    let vis = null;
    let ceil = null;
    let wind = null;
    let gust = null;
    let ageMinutes = null;

    if (metar) {
      vis = parseVisibility(metar.visib);
      ceil = ceilingFromMetarClouds(metar.clouds || []);
      if (ceil == null) ceil = 10000;

      const wspd = metar.wspd ?? metar.wspdKt ?? null;
      const wgst = metar.wgst ?? metar.wgstKt ?? null;
      if (typeof wspd === "number") wind = wspd;
      if (typeof wgst === "number") gust = wgst;

      ageMinutes = minutesSince(metar.obsTime);
    } else if (asos) {
      if (typeof asos.vsby === "number") vis = asos.vsby;
      const aCeil = ceilingFromAsos(asos);
      if (typeof aCeil === "number") ceil = aCeil;

      if (typeof asos.sped === "number") wind = asos.sped;
      if (typeof asos.gust === "number") gust = asos.gust;

      ageMinutes = minutesSince(asos.validUtc);
    }


    const hasObs = (vis != null) || (ceil != null);
    if (vis == null) vis = 10;
    if (ceil == null) ceil = 10000;

    const category = flightCategoryFromObs(vis, ceil);
    card.classList.add(category);

    const windLine = card.querySelector(".js-windline");
    const windEl = card.querySelector(".js-wind");
    const gustEl = card.querySelector(".js-gust");

    windEl.textContent = (typeof wind === "number") ? `Wind: ${wind} kt` : "";
    gustEl.textContent = (typeof gust === "number") ? `Gust: ${gust} kt` : "";
    windLine.style.display = (!windEl.textContent && !gustEl.textContent) ? "none" : "";

    const pillEl = card.querySelector(".js-pill");
    pillEl.textContent = category.toUpperCase();
    pillEl.classList.remove("vfr", "mvfr", "ifr", "lifr");
    pillEl.classList.add(category);

    // Collapsed metrics (right side, hidden when expanded)
    card.querySelector(".js-vis-collapsed").textContent = hasObs ? `${vis.toFixed(vis % 1 === 0 ? 0 : 1)}sm` : "--";
    card.querySelector(".js-ceil-collapsed").textContent = hasObs ? `${ceil.toLocaleString()}ft` : "--";

    // Expanded metrics (below airport name, shown when expanded)
    card.querySelector(".js-vis-expanded").textContent = hasObs ? `${vis.toFixed(vis % 1 === 0 ? 0 : 1)}sm` : "--";
    card.querySelector(".js-ceil-expanded").textContent = hasObs ? `${ceil.toLocaleString()}ft` : "--";

    const timelineContainer = card.querySelector(".js-timeline");
    if (timelineContainer) {
      renderTimelineInto(timelineContainer, timeline);
    }
    applyExpandedState(card, stKey);

    // alerts
    if (category === "ifr" || category === "lifr") {
      alerts.push({ type: "now", name: st.name, cat: category });
    }

    const firstIfr = findFirstIfrHour(timeline, IFR_LOOKAHEAD_HOURS);
    if (firstIfr) {
      alerts.push({
        type: "forecast",
        name: st.name,
        cat: (firstIfr.cat || "ifr").toLowerCase(),
        hourIso: firstIfr.hourIso
      });
    }

    list.appendChild(card);
  });

  renderAlerts(alerts);
}

/************************************
 * Refresh logic:
 * - Use cached payload if valid
 * - Otherwise fetch and re-render
 * - Auto refresh every 10 minutes
 ************************************/
let refreshTimer = null;
let refreshInProgress = false;
let currentAbortController = null;

async function refreshWeather(force = false) {
  // Prevent concurrent refresh calls
  if (refreshInProgress) {
    console.log("Refresh already in progress, skipping...");
    return;
  }

  // Use cache if valid (unless forced)
  if (!force) {
    const cached = loadCachedData();
    if (cached) {
      renderFromPayload(cached);
      return;
    }
  }

  refreshInProgress = true;
  
  // Cancel any previous in-flight request
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();

  try {
    setLoadingState(true);
    const payload = await fetchAirportsData(currentAbortController.signal);
    saveCachedData(payload);
    renderFromPayload(payload);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log("Request aborted");
      return;
    }
    console.error("Refresh failed:", err);
    showError(err.message || "Failed to fetch weather data");
  } finally {
    refreshInProgress = false;
    setLoadingState(false);
    currentAbortController = null;
  }
}

let visibilityHandler = null;

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);

  // Remove old visibility handler if it exists
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
  }

  // Refresh every 10 minutes while window stays open
  refreshTimer = setInterval(() => {
    // If tab is hidden, skip (we'll refresh on visibilitychange if stale)
    if (document.visibilityState !== "visible") return;
    refreshWeather(true).catch(console.error);
  }, DATA_TTL_MS);

  // If user returns to tab and cache is stale, refresh immediately
  visibilityHandler = () => {
    if (document.visibilityState === "visible" && isCacheStale()) {
      refreshWeather(true).catch(console.error);
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);
}

/************************************
 * Init
 ************************************/
// Ensure stations array is never empty
if (!stations || stations.length === 0) {
  stations = [...DEFAULT_STATIONS];
  saveStationsToStorage(stations);
}

initControls();
renderManagePanel();

// Initial render: cache-first, then fetch if needed
refreshWeather(false).catch(err => {
  console.error(err);
  showError(err.message || "Failed to load weather data");
});

// Auto refresh every 10 minutes
startAutoRefresh();
