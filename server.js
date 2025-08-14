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

/* -------------------- Utilidad espera texto -------------------- */
async function waitForAnyText(page, texts = [], timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const body = await page.evaluate(() => document.body.innerText || "");
    if (texts.some(t => new RegExp(t, "i").test(body))) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/* -------------------- API principal -------------------- */
app.get("/api/gel", async (req, res) => {
  const tracking = (req.query.tracking || "").trim();
  if (!tracking) return res.status(400).json({ ok: false, error: "Falta ?tracking=" });

  let browser;
  try {
    const executablePath = resolveChromeExecutable();
    if (!executablePath) {
      console.error("[api] Chrome no encontrado en", CACHE_DIR);
      return res.status(500).json({
        ok: false,
        error: `Chrome no encontrado. Revisa Build Command y PUPPETEER_CACHE_DIR.`
      });
    }
    console.log("[api] usando Chrome:", executablePath);

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process"
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    // bloquear recursos pesados
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const t = r.resourceType();
      if (t === "image" || t === "font" || t === "media") return r.abort();
      r.continue();
    });

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36");

    // 1) ir a la web
    await page.goto("https://globalexpresslog.com/paquetes-noidentificados/", {
      waitUntil: "networkidle2", timeout: 60000
    });

    // 2) formulario + input
    await page.waitForSelector("form.gv-search", { timeout: 20000 });
    const inputSel = [
      'form.gv-search input[type="search"]',
      'form.gv-search input[type="text"][name^="filter_"]',
      'form.gv-search input[placeholder*="Tracking"]',
      'form.gv-search input[placeholder*="Rastreo"]',
      'form.gv-search input[type="text"]'
    ].join(",");
    const input = await page.$(inputSel);
    if (!input) throw new Error("No encontré el campo de búsqueda.");

    await input.click({ clickCount: 3 });
    await input.type(tracking, { delay: 25 });

    const btnSel = [
      'form.gv-search input.gv-search-button',
      'form.gv-search input[type="submit"]',
      'form.gv-search button[type="submit"]'
    ].join(",");
    const btn = await page.$(btnSel);
    if (btn) await btn.click(); else await page.keyboard.press("Enter");

    // ⬆️ da tiempo extra a que aparezcan resultados (de 15s -> 25s)
    await waitForAnyText(page, [
      "Sin Resultado En Búsqueda",
      "FECHA DE INGRESO",
      "SACO",
      "CB#"
    ], 25000);

    // 3) EXTRAER con ventanas cercanas a la etiqueta
    const data = await page.evaluate(() => {
      const raw = document.body.innerText || "";
      const text = raw.replace(/\u00A0/g, " "); // NBSP -> espacio
      const fechaRe = /(\d{1,2}\/\d{1,2}\/\d{4})/;

      const hasDate = fechaRe.test(text);
      const hasCB   = /CB\s*#?\s*\d+/i.test(text);

      // "Sin Resultado..." solo si NO vemos fecha ni CB
      const noRes = /Sin Resultado En B[uú]squeda/i.test(text) && !(hasDate || hasCB);

      const sliceWindow = (label, len = 150) => {
        const idx = text.indexOf(label);
        if (idx === -1) return "";
        return text.slice(idx, idx + len);
      };

      // ---- SACO / CB ----
      let saco = null;
      // primero cerca de "SACO"
      let win = sliceWindow("SACO");
      let m = win.match(/(CB\s*#?\s*\d+|SACO\s*#?\s*\d+)/i);
      if (m) {
        saco = m[1].replace(/\s+/g, "")
                    .replace(/CB#?/i, "CB#")
                    .replace(/SACO#?/i, "SACO#");
      }
      // fallback: cerca de "CB" o global
      if (!saco) {
        m = sliceWindow("CB").match(/CB\s*#?\s*\d+/i) || text.match(/CB\s*#?\s*\d+/i);
        if (m) saco = m[0].replace(/\s+/g, "").replace(/CB#?/i, "CB#");
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

      return { noRes, saco, fecha };
    });

    res.json({
      ok: true,
      found: Boolean((data.saco || data.fecha) && !data.noRes),
      saco: data.saco || null,
      fecha_de_ingreso: data.fecha || null
    });

  } catch (e) {
    console.error("[/api/gel] Error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
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
