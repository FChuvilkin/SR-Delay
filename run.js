'use strict';
// Playwright runner: one fresh browser context (profile) per run.
// usage: node run.js [scenario ...] [--repeat N] [--headless]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const server = require('./server');

const PORT = Number(process.env.PORT || 4321);
const redact = (t) => (t && process.env.AMPLITUDE_API_KEY) ? String(t).split(process.env.AMPLITUDE_API_KEY).join('<API_KEY_REDACTED>') : t;
const SCENARIOS = {
  '1-fast':        { url: '/?scenario=fast',                      stay: 15000 },
  '2a-slow-stay':  { url: '/?scenario=slow',                      stay: 20000 },
  '2b-slow-leave': { url: '/?scenario=slow&leaveAt=3000',         closeAt: 3000 },
  '2c-slow-next':  { url: '/?scenario=slow&leaveAt=3000&next=1',  stay: 3000 + 15000 },
  '3-slow-fix':    { url: '/?scenario=slow&fix=1',                 stay: 20000 },
};

const args = process.argv.slice(2);
const repeat = Number((args.find((a) => a.startsWith('--repeat=')) || '--repeat=1').split('=')[1]);
const headless = args.includes('--headless');
const names = args.filter((a) => !a.startsWith('--'));
const selected = names.length ? names : Object.keys(SCENARIOS);

async function runOne(browser, name, spec, iteration) {
  const t0 = Date.now();
  const rel = () => Date.now() - t0;
  const log = { scenario: name, iteration, url: spec.url, started_at: new Date(t0).toISOString(), console: [], network: [], navigations: [] };
  const context = await browser.newContext();          // fresh localStorage / IndexedDB / remote-config cache
  const page = await context.newPage();
  page.on('console', (msg) => log.console.push({ ms: rel(), type: msg.type(), text: redact(msg.text()) }));
  page.on('request', (req) => {
    const u = req.url();
    if (!/api-sr|sr-client-cfg|\/collect$/.test(u)) return;
    const e = { ms: rel(), dir: 'req', method: req.method(), url: redact(u) };
    if (u.endsWith('/collect')) { try { const b = JSON.parse(req.postData()); e.event_type = b.event_type; e.time = b.time; e.ms_since_navigation = b.event_properties.ms_since_navigation; } catch (_) {} }
    if (u.includes('/sessions/v2/track')) { try { const b = JSON.parse(req.postData()); e.events_count = Array.isArray(b.events) ? b.events.length : undefined; e.seq = b.seq; e.body_bytes = (req.postData() || '').length; } catch (_) {} }
    log.network.push(e);
  });
  page.on('response', (res) => {
    const u = res.url();
    if (!/api-sr|sr-client-cfg/.test(u)) return;
    log.network.push({ ms: rel(), dir: 'res', status: res.status(), url: redact(u) });
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log.navigations.push({ ms: rel(), url: f.url() }); });

  console.log(`\n=== ${name} #${iteration}  ${spec.url}`);
  await page.goto(`http://localhost:${PORT}${spec.url}`, { waitUntil: 'commit' });

  const snapshot = () => page.evaluate(() => {
    const T = window.__sr || {};
    const stored = {};
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k.startsWith('sr_repro_marks_')) stored[k] = JSON.parse(sessionStorage.getItem(k)); }
    return { deviceId: T.deviceId, sessionId: T.sessionId, pageIndex: T.pageIndex, marks: T.marks, readyState: document.readyState, previousPagesMarks: stored };
  }).catch((e) => ({ error: String(e) }));

  if (spec.closeAt) {
    await page.waitForTimeout(spec.closeAt);
    log.page = await snapshot();
    log.closed_at_ms = rel();
    await page.close();                                 // tab close -> pagehide
    console.log(`  closed tab at ${log.closed_at_ms} ms`);
    await page.waitForTimeout(1500).catch(() => {});
  } else {
    await page.waitForTimeout(spec.stay);
    log.page = await snapshot();
  }
  await context.close();
  log.ended_at_ms = rel();

  const deviceId = log.page && log.page.deviceId;
  log.collect = server.collectLog.filter((e) => e.event.device_id === deviceId).map((e) => ({ ...e, received_rel_ms: e.received_at - t0 }));
  fs.mkdirSync('results', { recursive: true });
  const file = path.join('results', `${name}-${deviceId || 'unknown'}.json`);
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
  printSummary(log);
  console.log(`  -> ${file}`);
  return log;
}

function printSummary(log) {
  const allMarks = [];
  if (log.page && log.page.previousPagesMarks) for (const k of Object.keys(log.page.previousPagesMarks)) allMarks.push({ page: k.replace('sr_repro_marks_', ''), marks: log.page.previousPagesMarks[k] });
  if (log.page && log.page.marks) allMarks.push({ page: String(log.page.pageIndex), marks: log.page.marks });
  console.log(`  device=${log.page && log.page.deviceId} session=${log.page && log.page.sessionId}`);
  for (const p of allMarks) {
    const m = (n) => p.marks.find((x) => x.name === n);
    const pr = m('promise_resolved'), sr = m('collect:amplitude_session_replay'), dcl = m('DOMContentLoaded'), ld = m('load'), gb = m('guard_blocked');
    console.log(`  page ${p.page}: promise_resolved=${pr ? pr.ms + 'ms (' + pr.ready_state_at_resolve + ')' : '-'}  amplitude_session_replay=${sr ? sr.ms + 'ms' : (gb ? 'guard_blocked' : '-')}  DCL=${dcl ? dcl.ms + 'ms' : '-'}  load=${ld ? ld.ms + 'ms' : '-'}`);
  }
  const capture = log.console.filter((c) => /capture beginning|no ongoing recording|Session Replay/i.test(c.text)).slice(0, 6);
  for (const c of capture) console.log(`  sdk@${c.ms}ms: ${c.text.slice(0, 140)}`);
  const tracks = log.network.filter((n) => n.dir === 'req' && n.url.includes('/sessions/v2/track'));
  console.log(`  replay uploads: ${tracks.length}${tracks.length ? ' (first at ' + tracks[0].ms + 'ms, ' + tracks[0].events_count + ' events)' : ''}`);
  for (const c of log.collect) console.log(`  httpapi: ${c.event.event_type} time=${c.event.time} -> ${c.api_status}`);
}

(async () => {
  await server.start(PORT);
  let browser;
  try { browser = await chromium.launch({ headless, channel: 'chrome' }); console.log('[runner] using installed Google Chrome'); }
  catch (e) { console.log('[runner] Chrome channel unavailable, using bundled Chromium:', e.message.split('\n')[0]); browser = await chromium.launch({ headless }); }
  const results = [];
  for (let i = 1; i <= repeat; i++) for (const name of selected) {
    if (!SCENARIOS[name]) { console.error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(1); }
    results.push(await runOne(browser, name, SCENARIOS[name], i));
  }
  await browser.close();
  fs.writeFileSync(path.join('results', `_index-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify(results.map((r) => ({ scenario: r.scenario, iteration: r.iteration, deviceId: r.page && r.page.deviceId, sessionId: r.page && r.page.sessionId, started_at: r.started_at })), null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
