// server.js
"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();

/** CORS permisivo (si quieres, luego restringe a tus dominios) */
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// Preflight rápido + compatibilidad con iframes/origen null
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

/** Healthchecks y debug simple */
app.get("/ping", (_req, res) => res.type("text").send("ok"));
app.get("/env", (_req, res) => res.json({ PORT: process.env.PORT }));

/** Página principal (si subes un index.html a /public) */
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/** Utilidad: espera hasta que el body contenga algún texto esperado */
async function waitForAnyText(page, texts = [], timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const body = await page.evaluate(() => document.body.innerText || "");
    if (texts.some(t => new RegExp(t, "i").test(body))) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** API principal: /api/gel?tracking=XXXX */
app.get("/api/gel", async (req, res) => {
  const tracking = (req.query.tracking || "").trim();
  if (!tracking) return res.status(400).json({ ok: false, error: "Falta ?tracking=" });

  let browser;
  try {
    // Usa el Chrome instalado en el build por puppeteer
    const executablePath = puppeteer.executablePath();

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote"
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    // Bloquea recursos pesados para acelerar
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const t = r.resourceType();
      if (t === "image" || t === "font" || t === "media") return r.abort();
      r.continue();
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
    );

    // 1) Ir a la página origen
    await page.goto("https://globalexpresslog.com/paquetes-noidentificados/", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // 2) Formulario e input (GravityView/GravityForms)
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
    if (btn) await btn.click();
    else await page.keyboard.press("Enter");

    // 3) Esperar resultado o mensaje de no encontrado
    await waitForAnyText(page, [
      "Sin Resultado En Búsqueda",
      "FECHA DE INGRESO",
      "SACO",
      "CB#"
    ], 15000);

    // 4) Extraer datos del texto visible
    const data = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const noRes = /Sin Resultado En B[uú]squeda/i.test(text);

      const getAfter = (label) => {
        const re = new RegExp(label + "\\s+([^\\n\\r]+)", "i");
        const m = text.match(re);
        return m ? m[1].trim() : null;
      };

      const saco = getAfter("SACO") || getAfter("CB") || getAfter("CB#");
      let fecha = getAfter("FECHA DE INGRESO");
      if (!fecha) {
        const m = text.match(/FECHA[^\n\r]*?(\d{1,2}\/\d{1,2}\/\d{4})/i);
        if (m) fecha = m[1];
      }
      return { noRes, saco, fecha };
    });

    res.json({
      ok: true,
      found: !data.noRes && (data.saco || data.fecha),
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

/** Estáticos (sirve /public si lo usas) */
app.use(express.static("public"));

/** ---- INICIO DEL SERVIDOR con guard para evitar doble listen ---- */
const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] escuchando en puerto ${PORT}`);
  });
}
module.exports = app;
