const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
app.use(cors({ origin: true })); // permite llamadas desde tu web

app.get("/api/gel", async (req, res) => {
  const tracking = (req.query.tracking || "").trim();
  if (!tracking) return res.status(400).json({ ok: false, error: "Falta ?tracking=" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
    );

    // 1) Abre la página original
    await page.goto("https://globalexpresslog.com/paquetes-noidentificados/", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // 2) Encuentra el formulario y el input de búsqueda
    await page.waitForSelector("form.gv-search", { timeout: 20000 });
    const inputSel =
      'form.gv-search input[type="search"], form.gv-search input[type="text"][name^="filter_"], form.gv-search input[placeholder*="Tracking"], form.gv-search input[placeholder*="Rastreo"]';
    const searchSel =
      'form.gv-search input.gv-search-button, form.gv-search input[type="submit"], form.gv-search button[type="submit"]';

    const input = await page.$(inputSel);
    if (!input) throw new Error("No encontré el campo de búsqueda.");

    await input.click({ clickCount: 3 });
    await input.type(tracking, { delay: 25 });

    const btn = await page.$(searchSel);
    if (btn) await btn.click(); else await page.keyboard.press("Enter");

    // 3) Espera el render
    await page.waitForTimeout(3000);

    // 4) Extrae datos (SACO / FECHA DE INGRESO) del texto de la página
    const data = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const noRes = /Sin Resultado En B[uú]squeda/i.test(text);

      const getAfter = (label) => {
        const re = new RegExp(label + "\\s+([^\\n\\r]+)", "i");
        const m = text.match(re);
        return m ? m[1].trim() : null;
      };

      const saco = getAfter("SACO");
      let fecha = getAfter("FECHA DE INGRESO");
      if (!fecha) {
        const m = text.match(/FECHA[^\n\r]*?(\d{1,2}\/\d{1,2}\/\d{4})/i);
        if (m) fecha = m[1];
      }
      return { noRes, saco, fecha };
    });

    res.json({
      ok: true,
      found: data && !data.noRes && (data.saco || data.fecha),
      saco: data?.saco || null,
      fecha_de_ingreso: data?.fecha || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

// Sirve el frontend si lo ponemos en /public
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Escuchando en puerto " + PORT));
