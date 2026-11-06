'use strict';
// Serves the test page, the slow assets and the /collect proxy that stands in for
// Snowplow + server-side GTM (forwards events to the Amplitude HTTP V2 API).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    }
  } catch (e) { /* no .env */ }
})();

const API_KEY = process.env.AMPLITUDE_API_KEY;
const REGION = (process.env.REGION || 'US').toUpperCase();
if (!API_KEY) { console.error('AMPLITUDE_API_KEY missing (.env)'); process.exit(1); }

const ENDPOINTS = {
  US: { httpapi: 'https://api2.amplitude.com/2/httpapi', track: 'https://api-sr.amplitude.com/sessions/v2/track', config: 'https://sr-client-cfg.amplitude.com/config' },
  EU: { httpapi: 'https://api.eu.amplitude.com/2/httpapi', track: 'https://api-sr.eu.amplitude.com/sessions/v2/track', config: 'https://sr-client-cfg.eu.amplitude.com/config' },
}[REGION];
if (!ENDPOINTS) { console.error('REGION must be US or EU'); process.exit(1); }

const BODY_HOLD_MS = Number(process.env.BODY_HOLD_MS || 2000);   // keeps readyState === "loading"
const IMG_DELAY_MS = Number(process.env.IMG_DELAY_MS || 5000);   // pushes window "load" out
const PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Every event that went through /collect, with the HTTP API's answer.
const collectLog = [];

function renderPage(q) {
  const scenario = q.get('scenario') === 'slow' ? 'slow' : 'fast';
  const html = PAGE_TEMPLATE
    .replace(/__API_KEY__/g, API_KEY)
    .replace(/__TRACK_URL__/g, ENDPOINTS.track)
    .replace(/__CONFIG_URL__/g, ENDPOINTS.config)
    .replace(/__SLOW_IMG__/g, scenario === 'slow'
      ? `<p>Slow image below (delayed ${IMG_DELAY_MS} ms, holds window "load"):</p><img src="/slow.png?ms=${IMG_DELAY_MS}" alt="slow asset" width="1" height="1">`
      : '');
  return { scenario, html };
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
}

async function forwardToAmplitude(ev) {
  const event = {
    event_type: ev.event_type,
    device_id: String(ev.device_id),                 // >= 5 chars (HTTP API min_id_length)
    session_id: Number(ev.session_id),               // top-level, number (ms)
    time: Number(ev.time),                           // browser-supplied, rules out clock skew
    insert_id: ev.insert_id || crypto.randomUUID(),  // deduplication
    event_properties: ev.event_properties || {},
    platform: 'Web',
  };
  const received_at = Date.now();
  let api_status = null, api_response = null;
  try {
    const r = await fetch(ENDPOINTS.httpapi, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({ api_key: API_KEY, events: [event] }),
    });
    api_status = r.status; api_response = await r.text();
  } catch (e) { api_status = -1; api_response = String(e); }
  const entry = { received_at, forwarded_ms: Date.now() - received_at, event, api_status, api_response };
  collectLog.push(entry);
  console.log(`[collect] ${event.event_type} device=${event.device_id} time=${event.time} -> ${api_status} ${api_response}`);
  return entry;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    const { scenario, html } = renderPage(url.searchParams);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (scenario === 'fast') { res.end(html); return; }
    // slow: head + tag + ~2 KB padding now, rest of the document after BODY_HOLD_MS
    const idx = html.indexOf('<!--HOLD-->');
    const head = html.slice(0, idx) + '<!-- padding ' + 'x'.repeat(2048) + ' -->\n';
    const rest = html.slice(idx);
    res.write(head);
    setTimeout(() => res.end(rest), BODY_HOLD_MS);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/slow.png') {
    const ms = Number(url.searchParams.get('ms') || IMG_DELAY_MS);
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }); res.end(GIF); }, ms);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/collect') {
    let ev;
    try { ev = JSON.parse(await readBody(req)); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
    const entry = await forwardToAmplitude(ev);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ api_status: entry.api_status }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/collect-log') {
    const d = url.searchParams.get('device_id');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(d ? collectLog.filter((e) => e.event.device_id === d) : collectLog, null, 2));
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end('not found');
});

function start(port) {
  return new Promise((resolve) => server.listen(port, () => {
    console.log(`[server] http://localhost:${port}  region=${REGION}  body hold=${BODY_HOLD_MS}ms  image delay=${IMG_DELAY_MS}ms`);
    resolve(server);
  }));
}

module.exports = { start, collectLog, ENDPOINTS, REGION };
if (require.main === module) start(Number(process.env.PORT || 4321));
