const path = require("path");
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();

/* ... (CORS + /ping + /env + API como ya lo tienes) ... */

// 🌟 Raíz sin archivo: sirve un HTML mínimo integrado
app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>gel-scraper-proxy</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;color:#1c1c1e}
input{padding:.6rem .8rem;border:1px solid #e5e5ea;border-radius:10px;min-width:260px}button{padding:.6rem .9rem;border:0;border-radius:10px;background:#111;color:#fff;margin-left:.5rem;font-weight:600}
pre{background:#f7f7f7;padding:1rem;border-radius:10px;overflow:auto}</style></head>
<body>
<h2>Rastreo PSC — prueba rápida</h2>
<p>Escribe un tracking y presiona <b>Buscar</b>. Este HTML vive dentro del servidor, así evitas CORS.</p>
<div><input id="trk" placeholder="UUS57S2565569158307" /><button id="go">Buscar</button></div>
<pre id="out" aria-live="polite">Listo. Escribe un tracking…</pre>
<script>
const out=document.getElementById('out'), trk=document.getElementById('trk');
document.getElementById('go').onclick = async () => {
  const t=(trk.value||'').trim(); if(!t){ out.textContent='Escribe un tracking.'; return; }
  out.textContent='Consultando…';
  try{
    const r=await fetch('/api/gel?tracking='+encodeURIComponent(t),{cache:'no-store'});
    const txt=await r.text(); out.textContent=txt;
  }catch(e){ out.textContent='Error: '+(e.message||e); }
};
</script>
</body></html>`);
});

// (opcional) si luego subes /public, mantenlo:
app.use(express.static("public"));

/* ---- listen como ya lo tienes ---- */
const PORT = Number(process.env.PORT) || 3000;
if (r

