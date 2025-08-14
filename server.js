// server.js
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

console.log("[boot] NODE_ENV=%s PORT=%s", process.env.NODE_ENV, process.env.PORT);

const app = express();

/* -------------------- CORS -------------------- */
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (!req.headers.origin || req.headers.origin === "null") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* -------------------- Raíz / Health -------------------- */
app.get("/", (_req, res) =>
  res.type("text").send("gel-scraper-proxy OK. Endpoints: /ping /chrome-path /chrome-ls /api/gel?tracking=...")
);
app.get("/ping", (_req, res) => res.type("text").send("ok"));

/* -------------------- Chrome diagnostics -------------------- */
const CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || "/opt/render/project/src/.cache/puppeteer";

function resolveChromeExecutable() {
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  try {
    const chromeBase = path.join(CACHE_DIR, "chrome");
    const vers = fs.readdirSync(chromeBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    for (let i = vers.length - 1; i >= 0; i--) {
      const pth = path.join(chromeBase, vers[i], "chrome-linux64", "chrome");
      if (fs.existsSync(pth)) return pth;
    }
  } catch {}
  return null;
}

app.get("/chrome-path", (_req, res) => {
  const execPath = resolveChromeExecutable();
  res.json({
    PUPPETEER_CACHE_DIR: CACHE_DIR,
    resolved: execPath,
    exists: execPath ? fs.existsSync(execPath) : false
  });
});

app.get("/chrome-ls", (_req, res) => {
  const out = { cacheDir: CACHE_DIR, entries: [] };
  try {
    const base = path.join(CACHE_DIR, "chrome");
    out.entries = fs.readdirSync(base);
  } catch (e) {
    out.error = String(e.message || e);
  }
  res.json(out);
});

/* -------------------- Scraper helpers -------------------- */
async function getVisibleInputHandle(page, candidates, timeout = 30000) {
  await page.waitForFunction((sel) => {
    const list = Array.from(document.querySelectorAll(sel));
    return list.some(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    });
  }, { timeout }, candidates);

  const handle = await page.evaluateHandle((sel) => {
    const list = Array.from(document.querySelectorAll(sel));
    return list.find(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    }) || null;
  }, candidates);

  return handle && handle.asElement();
}

function extractCbAndFechaFromText(rawText) {
  const text = (rawText || "").replace(/\u00A0/g, " "); // NBSP -> espacio
  const fechaRe = /(\d{1,2}\/\d{1,2}\/\d{4})/;

  const sliceWindow = (label, len = 150) => {
    const idx = text.indexOf(label);
    if (idx === -1) return "";
    return text.slice(idx, idx + len);
  };

  // ---- CB / SACO normalizado ----
  let cb = null;
  let win = sliceWindow("SACO");
  let m = win.match(/(CB\s*#?\s*\d+|SACO\s*#?\s*\d+)/i);
  if (m) {
    cb = m[1].replace(/\s+/g, "")
             .replace(/CB#?/i, "CB#")
             .replace(/SACO#?/i, "SACO#");
  }
  if (!cb) {
    // ventana cerca de "CB" o global
    m = sliceWindow("CB").match(/CB\s*#?\s*\d+/i) || text.match(/CB\s*#?\s*\d+/i);
    if (m) cb = m[0].replace(/\s+/g, "").replace(/CB#?/i, "CB#");
  }

  // ---- FECHA ----
  let fecha = null;
  win = sliceWindow("FECHA DE INGRESO", 120);
  m = win.match(fechaRe);
  if (m) fecha = m[1];
  if (!fecha) {
    m = text.match(fechaRe);
    if (m) fecha = m[1];
  }

  // Señal de "sin resultado" real: aparece el texto y no vemos fecha ni CB
  const noResBanner = /Sin Resultado En B[uú]squeda/i.test(text);
  const found = Boolean((cb || fecha) && !noResBanner);

  return { cb, fecha, found };
}

async function scrapeGel(tracking, execPath) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: execPath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process" // RAM friendly
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    // Acelerar: bloquear imágenes/fuentes
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const t = r.resourceType();
      if (t === "image" || t === "font" || t === "media") return r.abort();
      r.continue();
    });

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36");
    await page.setExtraHTTPHeaders({ "accept-language": "es-ES,es;q=0.9,en;q=0.8" });

    // 1) Ir a la página (rápido) y luego esperar elementos
    await page.goto("https://globalexpresslog.com/paquetes-noidentificados/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // 2) Ocultar overlays/preloaders/cookies
    await page.evaluate(() => {
      const hide = (sel) => document.querySelectorAll(sel).forEach(el => (el.style.display = "none"));
      hide(".mk-body-loader-overlay, .page-preloader");
      hide("#omnisend-dynamic-container");
      hide(".cky-consent-container, .cookie-notice, .cn-wrapper");
    });

    // 3) Input visible (sin depender de form.gv-search)
    const INPUTS = [
      'input[placeholder*="Tracking" i]',
      'input[placeholder*="Rastreo" i]',
      'input[type="search"]',
      'input[name^="filter_"]',
      'input[type="text"]'
    ].join(",");

    const input = await getVisibleInputHandle(page, INPUTS, 30000);
    if (!input) throw new Error("No encontré un input visible para escribir el tracking.");

    await input.click({ clickCount: 3 });
    await input.type(tracking, { delay: 25 });

    // 4) Click en SEARCH/Buscar o submit/Enter
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a"));
      const byText = btns.find(b => /^(search|buscar)$/i.test((b.textContent || b.value || "").trim()));
      if (byText) { byText.click(); return true; }
      const form = (document.activeElement && document.activeElement.form) || document.querySelector("form");
      if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
      return false;
    });
    if (!clicked) await page.keyboard.press("Enter");

    // 5) Esperar texto de resultados
    await page.waitForTimeout(1500);
    const ok = await page.waitForFunction(() => {
      const t = document.body.innerText || "";
      return /Sin Resultado En B[uú]squeda/i.test(t) ||
             /FECHA DE INGRESO/i.test(t) ||
             /SACO/i.test(t) || /CB#/i.test(t);
    }, { timeout: 25000 }).catch(() => false);

    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const { cb, fecha, found } = extractCbAndFechaFromText(bodyText);

    return { ok: Boolean(ok), found, cb, fecha, _debugBody: bodyText.slice(0, 1500) };
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}

/* -------------------- API: SOLO cb y fecha -------------------- */
app.get("/api/gel", async (req, res) => {
  const tracking = (req.query.tracking || "").trim();
  const debug = String(req.query.debug || "0") === "1";
  if (!tracking) return res.status(400).json({ ok: false, error: "Falta ?tracking=" });

  const execPath = resolveChromeExecutable();
  if (!execPath) {
    console.error("[api] Chrome no encontrado en", CACHE_DIR);
    return res.status(500).json({
      ok: false,
      error: `Chrome no encontrado. Revisa Build Command y PUPPETEER_CACHE_DIR.`
    });
  }
  console.log("[api] usando Chrome:", execPath);

  try {
    const result = await scrapeGel(tracking, execPath);
    const payload = {
      ok: true,
      found: result.found,
      cb: result.cb || null,
      fecha: result.fecha || null
    };
    if (debug) payload._debugBody = result._debugBody;
    res.json(payload);
  } catch (e) {
    console.error("[/api/gel] Error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* -------------------- Inicio del servidor -------------------- */
const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log(`[server] escuchando en puerto ${PORT}`));
}
module.exports = app;

/* -------------------- Logs globales -------------------- */
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException",  (e) => console.error("[uncaughtException]", e));
