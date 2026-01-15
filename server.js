// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------------------------------------------------
   Settings
--------------------------------------------------------- */
const TTL_MS = 10 * 60 * 1000; // 10 minutes

/* ---------------------------------------------------------
   Basic logging
--------------------------------------------------------- */
app.use((req, res, next) => {
  console.log(`EXPRESS: ${req.method} ${req.url}`);
  next();
});

/* ---------------------------------------------------------
   Rate limit all /api routes
   Tune "max" depending on how many clients you expect.
--------------------------------------------------------- */
const apiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 300, // 300 requests / IP / 10 minutes
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api/", apiLimiter);

/* ---------------------------------------------------------
   Static
--------------------------------------------------------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------------------------------------------------------
   Simple in-memory cache for upstream responses
   (key -> { expires, status, body, contentType })
--------------------------------------------------------- */
const upstreamCache = new Map();

function getCached(key) {
  const v = upstreamCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) {
    upstreamCache.delete(key);
    return null;
  }
  return v;
}

function setCached(key, payload, ttlMs = TTL_MS) {
  upstreamCache.set(key, { ...payload, expires: Date.now() + ttlMs });
}

function sendCachedOrSet(res, cacheKey, status, body, contentType = "application/json") {
  // Cache only successful JSON responses by default
  if (status === 200) {
    setCached(cacheKey, { status, body, contentType });
    res.set("Cache-Control", "public, max-age=600");
  } else {
    res.set("Cache-Control", "no-store");
  }
  res.set("Content-Type", contentType);
  return res.status(status).send(body);
}

/* ---------------------------------------------------------
   Helper: fetch text with headers
--------------------------------------------------------- */
async function fetchText(url, headers = {}) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "RWJ-Weather/1.0 (contact: ops@example.com)",
      ...headers
    }
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

/* ---------------------------------------------------------
   TEST
--------------------------------------------------------- */
app.get("/api/test", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ---------------------------------------------------------
   METAR proxy (AWC)
   /api/metar?ids=KMJX,KWRI,KACY
--------------------------------------------------------- */
app.get("/api/metar", async (req, res) => {
  try {
    const ids = (req.query.ids || "").toString().trim();
    if (!ids) return res.status(400).json({ error: "Missing ids=..." });

    const cacheKey = `metar:${ids}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=600");
      res.set("Content-Type", cached.contentType || "application/json");
      return res.status(cached.status).send(cached.body);
    }

    const url =
      `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`;

    const r = await fetch(url, { headers: { "User-Agent": "RWJ-Weather/1.0" } });
    const text = await r.text();

    if (!r.ok) {
      return res.status(502).json({
        error: "METAR upstream failed",
        status: r.status,
        body: text.slice(0, 400)
      });
    }

    // Ensure it's valid JSON
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "METAR upstream returned non-JSON",
        body: text.slice(0, 400)
      });
    }

    return sendCachedOrSet(
      res,
      cacheKey,
      200,
      JSON.stringify(json),
      "application/json"
    );
  } catch (e) {
    console.error("METAR proxy failed:", e);
    res.status(500).json({ error: "METAR proxy failed" });
  }
});

/* ---------------------------------------------------------
   TAF timeline (AWC)
   /api/tafTimeline?ids=KMJX,KWRI,KACY&hours=24

   NOTE: timeline categories come from your server logic.
   If ceiling/vis is missing for a period, we return "unk".
--------------------------------------------------------- */
function parseVisibToNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace("+", ""));
  return Number.isFinite(n) ? n : null;
}

function ceilingFromClouds(clouds = []) {
  const ceilings = (clouds || [])
    .filter(l => l && (l.cover === "BKN" || l.cover === "OVC" || l.cover === "VV"))
    .map(l => l.base)
    .filter(v => typeof v === "number" && Number.isFinite(v));
  return ceilings.length ? Math.min(...ceilings) : null;
}

function flightCategory(vis, ceil) {
  if (vis < 1 || ceil < 500) return "lifr";
  if (vis < 3 || ceil < 1000) return "ifr";
  if (vis < 5 || ceil < 3000) return "mvfr";
  return "vfr";
}

function topOfHour(d) {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  return x;
}

function normalizeTafArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.tafs)) return json.tafs;
  if (json && Array.isArray(json.items)) return json.items;
  return [];
}

function getFcsts(tafObj) {
  if (!tafObj) return [];
  if (Array.isArray(tafObj.fcsts)) return tafObj.fcsts;
  if (Array.isArray(tafObj.forecasts)) return tafObj.forecasts;
  return [];
}

app.get("/api/tafTimeline", async (req, res) => {
  try {
    const ids = (req.query.ids || "").toString().trim();
    const hours = Math.min(Math.max(parseInt(req.query.hours || "24", 10), 1), 48);
    if (!ids) return res.status(400).json({ error: "Missing ids=..." });

    const cacheKey = `tafTimeline:${ids}:${hours}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=600");
      res.set("Content-Type", cached.contentType || "application/json");
      return res.status(cached.status).send(cached.body);
    }

    const tafUrl =
      `https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(ids)}&format=json`;

    const { ok, status, text } = await fetchText(tafUrl, { Accept: "application/json" });

    if (!ok) {
      return res.status(502).json({
        error: "TAF upstream failed",
        status,
        upstreamUrl: tafUrl,
        body: text.slice(0, 800)
      });
    }

    let tafJson;
    try {
      tafJson = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "TAF upstream returned non-JSON",
        upstreamUrl: tafUrl,
        body: text.slice(0, 800)
      });
    }

    const tafs = normalizeTafArray(tafJson);
    const want = ids.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

    const start = topOfHour(new Date());
    const out = [];

    for (const t of tafs) {
      const icaoId = (t.icaoId || t.stationId || t.station || t.id || "")
        .toString()
        .toUpperCase()
        .trim();

      const fcsts = getFcsts(t);
      const timeline = [];

      for (let i = 0; i < hours; i++) {
        const hour = new Date(start.getTime() + i * 60 * 60 * 1000);
        const hourUnix = Math.floor(hour.getTime() / 1000);

        let active = null;
        for (const f of fcsts) {
          if (typeof f?.timeFrom === "number" && typeof f?.timeTo === "number") {
            if (hourUnix >= f.timeFrom && hourUnix < f.timeTo) {
              active = f;
              break;
            }
          }
        }

        const vis = parseVisibToNumber(active?.visib);
        const ceil = ceilingFromClouds(active?.clouds || []);

        // Extract wind data
        const windSpeed = typeof active?.wspd === "number" ? active.wspd : 
                         typeof active?.wspdKt === "number" ? active.wspdKt : null;
        const windGust = typeof active?.wgst === "number" ? active.wgst : 
                         typeof active?.wgstKt === "number" ? active.wgstKt : null;
        const windDir = typeof active?.wdir === "number" ? active.wdir : null;

        // Determine flight category with fallbacks
        let cat = "unk";
        
        // First, check if TAF provides a flightCat directly
        if (active?.flightCat) {
          const fc = String(active.flightCat).toLowerCase();
          if (["vfr", "mvfr", "ifr", "lifr"].includes(fc)) {
            cat = fc;
          }
        }
        
        // If no direct flightCat, calculate from visibility and ceiling
        if (cat === "unk") {
          if (typeof vis === "number" && typeof ceil === "number") {
            // Both available - use both
            cat = flightCategory(vis, ceil);
          } else if (typeof vis === "number") {
            // Only visibility available - assume unlimited ceiling (10000ft) for calculation
            cat = flightCategory(vis, 10000);
          } else if (typeof ceil === "number") {
            // Only ceiling available - assume unlimited visibility (10sm) for calculation
            cat = flightCategory(10, ceil);
          }
        }

        // Include detailed data for tooltips
        timeline.push({ 
          hourIso: hour.toISOString(), 
          cat,
          vis: vis,
          ceil: ceil,
          windSpeed: windSpeed,
          windGust: windGust,
          windDir: windDir
        });
      }

      out.push({ icaoId, timeline });
    }

    const got = new Set(out.map(x => x.icaoId));
    for (const id of want) {
      if (!got.has(id)) out.push({ icaoId: id, timeline: [], parseError: "No TAF returned" });
    }

    return sendCachedOrSet(
      res,
      cacheKey,
      200,
      JSON.stringify(out),
      "application/json"
    );
  } catch (e) {
    console.error("TAF timeline failed:", e);
    res.status(500).json({ error: "TAF timeline failed", detail: e?.message || String(e) });
  }
});

/* ---------------------------------------------------------
   IEM ASOS/AWOS latest fallback
   /api/asosLatest?network=NJ_ASOS&stations=BLM,NEL,MJX
--------------------------------------------------------- */
app.get("/api/asosLatest", async (req, res) => {
  try {
    const network = (req.query.network || "NJ_ASOS").toString().trim();
    const stationsParam = (req.query.stations || "").toString().trim();
    if (!stationsParam) return res.status(400).json({ error: "Missing stations=..." });

    const stations = stationsParam
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    const cacheKey = `asosLatest:${network}:${stations.join(",")}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=600");
      res.set("Content-Type", cached.contentType || "application/json");
      return res.status(cached.status).send(cached.body);
    }

    // pull last 24h (covers low-update AWOS)
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const y1 = start.getUTCFullYear();
    const m1 = start.getUTCMonth() + 1;
    const d1 = start.getUTCDate();
    const y2 = now.getUTCFullYear();
    const m2 = now.getUTCMonth() + 1;
    const d2 = now.getUTCDate();

    const params = new URLSearchParams();
    params.set("network", network);
    stations.forEach(st => params.append("station", st));

    // fields
    params.append("data", "vsby");
    params.append("data", "wdir");
    params.append("data", "sped");
    params.append("data", "gust");
    params.append("data", "tmpf");

    params.append("data", "skyc1");
    params.append("data", "skyc2");
    params.append("data", "skyc3");
    params.append("data", "skyc4");

    params.append("data", "skyl1");
    params.append("data", "skyl2");
    params.append("data", "skyl3");
    params.append("data", "skyl4");

    params.set("year1", String(y1));
    params.set("month1", String(m1));
    params.set("day1", String(d1));
    params.set("year2", String(y2));
    params.set("month2", String(m2));
    params.set("day2", String(d2));

    params.set("tz", "Etc/UTC");
    params.set("format", "onlycomma");
    params.set("latlon", "no");
    params.set("elev", "no");
    params.set("missing", "M");
    params.set("trace", "T");
    params.set("direct", "no");
    params.append("report_type", "3");
    params.append("report_type", "4");

    const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${params.toString()}`;

    const { ok, status, text } = await fetchText(url);
    if (!ok) {
      return res.status(502).json({
        error: "ASOS upstream failed",
        status,
        body: text.slice(0, 400)
      });
    }

    const lines = text.trim().split("\n");
    if (lines.length < 2) {
      return sendCachedOrSet(res, cacheKey, 200, JSON.stringify([]), "application/json");
    }

    const header = lines[0].split(",").map(h => h.trim());
    const idx = (name) => header.indexOf(name);

    const iStation = idx("station");
    const iValid = idx("valid");
    const iVsby = idx("vsby");
    const iWdir = idx("wdir");
    const iSped = idx("sped");
    const iGust = idx("gust");
    const iTmpf = idx("tmpf");

    const iSkyc1 = idx("skyc1"), iSkyc2 = idx("skyc2"), iSkyc3 = idx("skyc3"), iSkyc4 = idx("skyc4");
    const iSkyl1 = idx("skyl1"), iSkyl2 = idx("skyl2"), iSkyl3 = idx("skyl3"), iSkyl4 = idx("skyl4");

    const toNum = (v) => (v == null || v === "" || v === "M" ? null : Number(v));
    const toStr = (v) => (v == null || v === "" || v === "M" ? null : String(v).trim());

    const latest = new Map();

    for (let li = 1; li < lines.length; li++) {
      const row = lines[li].split(",");
      const st = (row[iStation] || "").trim().toUpperCase();
      const valid = (row[iValid] || "").trim();
      if (!st || !valid) continue;

      // valid: "YYYY-MM-DD HH:MM" in UTC
      const t = Date.parse(valid.replace(" ", "T") + "Z");
      if (!Number.isFinite(t)) continue;

      const prev = latest.get(st);
      if (!prev || t > prev._t) {
        latest.set(st, {
          station: st,
          validUtc: new Date(t).toISOString(),
          vsby: toNum(row[iVsby]),
          wdir: toNum(row[iWdir]),
          sped: toNum(row[iSped]),  // knots
          gust: toNum(row[iGust]),  // knots
          tmpf: toNum(row[iTmpf]),

          skyc1: toStr(row[iSkyc1]), skyc2: toStr(row[iSkyc2]), skyc3: toStr(row[iSkyc3]), skyc4: toStr(row[iSkyc4]),
          skyl1: toNum(row[iSkyl1]), skyl2: toNum(row[iSkyl2]), skyl3: toNum(row[iSkyl3]), skyl4: toNum(row[iSkyl4]),

          _t: t
        });
      }
    }

    const out = Array.from(latest.values()).map(({ _t, ...rest }) => rest);

    return sendCachedOrSet(
      res,
      cacheKey,
      200,
      JSON.stringify(out),
      "application/json"
    );
  } catch (e) {
    console.error("ASOS proxy failed:", e);
    res.status(500).json({ error: "ASOS proxy failed" });
  }
});

/* ---------------------------------------------------------
   SPA fallback
--------------------------------------------------------- */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------------------------------------------------
   Start
--------------------------------------------------------- */
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Test:  http://${HOST}:${PORT}/api/test`);
});
