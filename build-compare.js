'use strict';
// Builds compare.html from results/*.json plus the Amplitude timelines fetched after the run.
const fs = require('fs');
const path = require('path');

// Amplitude User Lookup timelines (client timestamps, UTC) and replay list, fetched 2026-11-06 after the batch.
const AMP = {
  'sr-test-fast-1793972011611': { events: [['13:33:31.611','page_view'],['13:33:31.712','page_timing'],['13:33:32.992','amplitude_session_replay'],['13:33:32.993','[Amplitude] Replay Captured']], replay: '13:33:32.993' },
  'sr-test-fast-1793972062308': { events: [['13:34:22.308','page_view'],['13:34:22.405','page_timing'],['13:34:22.455','amplitude_session_replay'],['13:34:22.456','[Amplitude] Replay Captured']], replay: '13:34:22.456' },
  'sr-test-fast-1793972139509': { events: [['13:35:39.509','page_view'],['13:35:39.614','page_timing'],['13:35:39.664','amplitude_session_replay'],['13:35:39.665','[Amplitude] Replay Captured']], replay: '13:35:39.665' },
  'sr-test-fast-1793972216753': { events: [['13:36:56.753','page_view'],['13:36:56.851','page_timing'],['13:36:56.901','amplitude_session_replay'],['13:36:56.902','[Amplitude] Replay Captured']], replay: '13:36:56.902' },
  'sr-test-slow-1793972077580': { events: [['13:34:37.580','page_view'],['13:34:37.731','amplitude_session_replay'],['13:34:40.588','[Amplitude] Replay Captured'],['13:34:45.604','page_timing']], replay: '13:34:40.588', firstNav: '13:34:45.583' },
  'sr-test-slow-1793972154764': { events: [['13:35:54.764','page_view'],['13:35:54.921','amplitude_session_replay'],['13:35:57.775','[Amplitude] Replay Captured'],['13:36:02.784','page_timing']], replay: '13:35:57.775' },
  'sr-test-slow-1793972231991': { events: [['13:37:11.991','page_view'],['13:37:12.148','amplitude_session_replay'],['13:37:15.005','[Amplitude] Replay Captured'],['13:37:20.013','page_timing']], replay: '13:37:15.005' },
  'sr-test-slow-1793972097789': { events: [['13:34:57.789','page_view'],['13:34:57.951','amplitude_session_replay']], replay: null },
  'sr-test-slow-1793972175030': { events: [['13:36:15.030','page_view'],['13:36:15.186','amplitude_session_replay']], replay: null },
  'sr-test-slow-1793972252185': { events: [['13:37:32.185','page_view'],['13:37:32.335','amplitude_session_replay']], replay: null },
  'sr-test-slow-1793972101009': { events: [['13:35:01.009','page_view'],['13:35:01.160','amplitude_session_replay'],['13:35:04.023','[Amplitude] Replay Captured'],['13:35:04.039','page_view (page 2)'],['13:35:04.050','page_timing (page 2)']], replay: '13:35:04.023', firstNav: '13:35:04.052', firstNavUrl: '/?scenario=fast&from=slow' },
  'sr-test-slow-1793972178280': { events: [['13:36:18.280','page_view'],['13:36:18.451','amplitude_session_replay'],['13:36:21.292','[Amplitude] Replay Captured'],['13:36:21.305','page_view (page 2)'],['13:36:21.314','page_timing (page 2)']], replay: '13:36:21.292' },
  'sr-test-slow-1793972255444': { events: [['13:37:35.444','page_view'],['13:37:35.622','amplitude_session_replay'],['13:37:38.503','page_view (page 2)'],['13:37:38.512','page_timing (page 2)'],['13:37:38.513','[Amplitude] Replay Captured']], replay: '13:37:38.513' },
  'sr-test-slow-1793972119194': { events: [['13:35:19.194','page_view'],['13:35:22.194','[Amplitude] Replay Captured'],['13:35:27.214','page_timing'],['13:35:27.253','amplitude_session_replay']], replay: '13:35:22.194' },
  'sr-test-slow-1793972196515': { events: [['13:36:36.515','page_view'],['13:36:39.529','[Amplitude] Replay Captured'],['13:36:44.536','page_timing'],['13:36:44.568','amplitude_session_replay']], replay: '13:36:39.529' },
  'sr-test-slow-1793972273672': { events: [['13:37:53.672','page_view'],['13:37:56.687','[Amplitude] Replay Captured'],['13:38:01.696','page_timing'],['13:38:01.728','amplitude_session_replay']], replay: '13:37:56.687' },
};

const SCENARIOS = {
  '1-fast': { n: '1', short: 'Fast page', title: 'Fast page (control)', url: '/?scenario=fast, stay 15 s', verdict: 'Inverted by 1 ms',
    plain: 'The page loads instantly. The SDK finishes initializing after the HTML is already parsed, so the recorder takes its first snapshot the moment it starts. Even so, the customer\'s event goes out 1 ms before Replay Captured, because the SDK starts the recorder asynchronously, just after the promise callback has run. The right order is Replay Captured first, then the customer\'s event, so even the fast page is inverted, by a single millisecond.',
    server: [[0, 'Whole HTML sent at once. No slow assets.']] },
  '2a-slow-stay': { n: '2a', short: 'Slow, stays', title: 'Slow page, user stays 20 s', url: '/?scenario=slow, stay 20 s', verdict: 'Inverted by 2.9 s',
    plain: 'The HTML is held back for 3 s and an image for 8 s. The SDK finishes initializing at about 150 ms while the HTML is still arriving, so the recorder waits for window load. The customer\'s event goes out at once; Amplitude dates the replay from the moment HTML parsing finished (3 s).',
    server: [[0, 'Sent the <head>: the SDK script, the customer\'s tag and about 2 KB of padding. Then stopped sending.'], [3000, 'Sent the rest of the HTML (<body>), which includes <img src="/slow.png">.'], ['3,000 to 8,000', 'Held the image request for 5 s, then answered with a 1×1 GIF.']] },
  '2b-slow-leave': { n: '2b', short: 'Slow, leaves', title: 'Slow page, tab closed at 3 s', url: '/?scenario=slow&leaveAt=3000, tab closed at 3 s', verdict: 'No replay at all',
    plain: 'Same slow page, but the tab is closed at 3.2 s, before window load. The SDK never uploads anything, so Amplitude has the page view and the customer\'s event but no Replay Captured and no replay.',
    server: [[0, 'Sent the <head>: the SDK script, the customer\'s tag and about 2 KB of padding. Then stopped sending.'], [3000, 'Sent the rest of the HTML (<body>), which includes <img src="/slow.png">.'], ['3,000 to 8,000', 'Held the image request for 5 s (the tab closes before it is answered).'], ['≈3,200', 'The runner closes the tab (the user leaves).']] },
  '2c-slow-next': { n: '2c', short: 'Slow, next page', title: 'Slow page, then a fast page in the same session', url: '/?scenario=slow&leaveAt=3000&next=1 → /?scenario=fast, stay 15 s', verdict: 'Inverted by 2.9 s, replay starts on page 2',
    plain: 'Same slow page, but at 3 s the user clicks through to a fast page in the same session. Page 1 is never recorded. The replay begins on page 2, and Replay Captured lands about 3 s after page 1\'s customer event. The localStorage guard stops the event from being sent again on page 2. This is the inversion seen in the customer\'s funnel.',
    server: [[0, 'Sent the <head>: the SDK script, the customer\'s tag and about 2 KB of padding. Then stopped sending.'], [3000, 'Sent the rest of the HTML (<body>), which includes <img src="/slow.png">.'], [3000, 'The page navigates itself to /?scenario=fast (the user clicks through). Page 2 is served at once, no slow assets.']] },
  '3-slow-fix': { n: '3', short: 'Slow + fix', title: 'Slow page with the fix in the tag', url: '/?scenario=slow&fix=1, stay 20 s', verdict: 'Correct order (Replay Captured first)',
    plain: 'Same slow page, but the tag checks document.readyState when the promise resolves. It is "loading", so the customer\'s event waits for window load plus 50 ms. Replay Captured now comes 5 s before the customer\'s event.',
    server: [[0, 'Sent the <head>: the SDK script, the customer\'s tag and about 2 KB of padding. Then stopped sending.'], [3000, 'Sent the rest of the HTML (<body>), which includes <img src="/slow.png">.'], ['3,000 to 8,000', 'Held the image request for 5 s, then answered with a 1×1 GIF.']] },
};

function explainMark(m, scenario, page) {
  const slow = scenario !== '1-fast';
  const p2 = page === 2 ? 'Page 2: ' : '';
  switch (m.name) {
    case 'collect:page_view': return [p2 + 'page_view sent to the collector', 'Stand-in for Snowplow\'s page view. Goes out before the SDK runs.'];
    case 'init_called': return [p2 + 'Tag calls sessionReplay.init(...)', 'The customer\'s tag starts the SDK.'];
    case 'promise_resolved': return [p2 + 'init().promise resolves, readyState = "' + m.ready_state_at_resolve + '"', 'The .then() callback runs. getSessionReplayProperties() already returns a replay ID' + (m.ready_state_at_resolve === 'loading' ? ', but nothing has been recorded: the recorder is waiting for window load.' : '.')];
    case 'collect:amplitude_session_replay': return [p2 + 'amplitude_session_replay sent to the collector', 'The customer\'s synthetic event.' + (m.ms < 1000 && slow ? ' Sent while the HTML is still loading.' : (!slow ? ' Sent 1 ms before the recorder actually starts.' : ''))];
    case 'fix_waiting_for_load': return [p2 + 'Fix: event deferred', 'readyState is "loading", so the tag waits for window load + 50 ms before sending.'];
    case 'guard_blocked': return [p2 + 'Guard blocks the event', 'localStorage key for this device/session is already "sent" (set on page 1), so nothing is sent again.'];
    case 'DOMContentLoaded': return [p2 + 'DOMContentLoaded', slow && page !== 2 ? 'The HTML finished parsing. The recorder writes a 112-byte marker (this is the time Amplitude uses for Replay Captured) but takes no snapshot yet.' : 'The HTML finished parsing.'];
    case 'load': return [p2 + 'window load', slow && page !== 2 ? 'The slow image finished. Now the recorder takes its first full snapshot of the page.' : 'All assets loaded.'];
    case 'collect:page_timing': return [p2 + 'page_timing sent to the collector', 'Our debug event carrying the DOMContentLoaded and load times.'];
    case 'navigating_next': return ['Page navigates to /?scenario=fast', 'The user clicks through to the next page.'];
    case 'pagehide': return ['Page 1 unloads', 'The SDK keeps whatever it recorded (the DCL marker) in IndexedDB for the same session.'];
    default: return [p2 + m.name, ''];
  }
}

function fmt(ms) { return Math.round(ms).toLocaleString('en-US'); }
function toMs(hms) { const [h, m, s] = hms.split(':'); return ((+h * 60 + +m) * 60 + parseFloat(s)) * 1000; }

const runs = [];
for (const f of fs.readdirSync('results').filter((f) => /^(1-fast|2a|2b|2c|3-)/.test(f) && f.endsWith('.json')).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join('results', f), 'utf8'));
  const scenario = r.scenario;
  const nav0 = r.navigations[0].ms;
  const nav1 = r.navigations[1] ? r.navigations[1].ms - nav0 : null;
  const rows = [];
  const push = (ms, approx, what, why, kind) => rows.push({ ms, approx, what, why, kind });

  // page 1 marks (and page 2 marks shifted by the navigation offset)
  const prev = Object.values(r.page.previousPagesMarks || {});
  const marksP1 = prev.length ? prev[0] : r.page.marks;
  const marksP2 = prev.length ? r.page.marks : null;
  for (const m of marksP1) { const [what, why] = explainMark(m, scenario, 1); push(m.ms, false, what, why, m.name === 'collect:amplitude_session_replay' ? 'synthetic' : (m.name.startsWith('collect:') ? 'collect' : 'page')); }
  if (marksP2) for (const m of marksP2) { const [what, why] = explainMark(m, scenario, 2); push(m.ms + nav1, true, what, why, m.name.startsWith('collect:') ? 'collect' : 'page'); }

  // network + SDK console (runner clock, converted)
  let cfgN = 0;
  for (const n of r.network) {
    const ms = n.ms - nav0;
    if (n.url.includes('sr-client-cfg')) {
      if (n.dir === 'req') push(ms, true, (cfgN ? 'Page 2: ' : '') + 'SDK requests remote config', 'GET sr-client-cfg.amplitude.com/config, the first thing init() does.', 'sdk');
      else { push(ms, true, (cfgN ? 'Page 2: ' : '') + 'Remote config response (HTTP ' + n.status + ')', 'Empty config, so the tag\'s sampleRate: 1 applies.', 'sdk'); cfgN++; }
    }
  }
  const tracks = r.network.filter((n) => n.dir === 'req' && n.url.includes('/sessions/v2/track'));
  tracks.forEach((n, i) => {
    const ms = n.ms - nav0;
    let why = n.events_count + ' events, ' + n.body_bytes.toLocaleString('en-US') + ' bytes.';
    if (i === 0) why += scenario === '1-fast' ? ' Already holds the full snapshot.' : (scenario === '2c-slow-next' ? ' Page 2 recording (the full snapshot of page 2).' : ' Only the DOMContentLoaded marker (112 bytes). Nothing was uploaded before this.');
    if (i === 1 && scenario !== '1-fast' && scenario !== '2c-slow-next') why += ' The full snapshot plus first mutations.';
    if (i < 2) push(ms, true, (i === 0 ? 'First' : 'Second') + ' replay upload to api-sr.amplitude.com', why, 'replay');
  });
  if (tracks.length > 2) push(tracks[2].ms - nav0, true, (tracks.length - 2) + ' more replay uploads until the run ends', 'Ongoing recording, every 2 to 3 s.', 'replay');
  for (const c of r.console) {
    if (/capture beginning/.test(c.text)) push(c.ms - nav0, true, 'SDK log: "Session Replay capture beginning"', 'The SDK has called the recorder. The recorder checks readyState: if "loading" it waits for window load, otherwise it snapshots now.', 'sdk');
    if (/received from cache/.test(c.text)) push(c.ms - nav0, true, 'Page 2: remote config served from localStorage cache', 'No network fetch on later pages, so init() resolves even sooner.', 'sdk');
  }
  if (r.closed_at_ms) push(r.closed_at_ms - nav0, true, 'Tab closed by the runner', 'The user leaves. No replay upload has happened.', 'page');
  rows.sort((a, b) => a.ms - b.ms);

  const amp = AMP[r.page.deviceId];
  const t0 = toMs(amp.events[0][0]);
  const ampRows = amp.events.map(([t, e]) => ({ t, e, off: toMs(t) - t0 }));
  runs.push({
    scenario, iteration: r.iteration, device: r.page.deviceId, session: r.page.sessionId, startedAt: r.started_at,
    rows, ampRows,
    replay: amp.replay ? { start: amp.replay, startOff: toMs(amp.replay) - t0, firstNav: amp.firstNav ? { t: amp.firstNav, off: toMs(amp.firstNav) - t0, url: amp.firstNavUrl || '/?scenario=slow' } : null } : null,
  });
}
// the smoke run is iteration 1 of 1-fast twice; renumber by start time
const byScenario = {};
for (const run of runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) { (byScenario[run.scenario] = byScenario[run.scenario] || []).push(run); }
for (const k in byScenario) byScenario[k].forEach((run, i) => { run.label = 'Run ' + (i + 1) + (k === '1-fast' && i === 0 ? ' (smoke test, cold connection)' : ''); });

const DATA = { scenarios: SCENARIOS, runs: byScenario, order: Object.keys(SCENARIOS) };

const html = `<title>Replay Timing Comparison</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a lab notebook. Scenario tabs on top, one run at a time, three stacked tables that share one time axis (ms after navigation). */
:root {
  --bg: #f7f6f2; --fg: #1f2429; --muted: #6b7079; --line: #d9d6cd; --panel: #ffffff;
  --accent: #2f5d8a;        /* Amplitude side */
  --synthetic: #b2541a;     /* the customer's event */
  --replay: #1f7a6d;        /* replay data */
  --pass: #2d7a3e; --fail: #a33a2b; --chip-bg: #ecebe5;
  --font-body: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
  --font-mono: "IBM Plex Mono", "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #16191d; --fg: #e6e4de; --muted: #9a9ea6; --line: #33373d; --panel: #1e2227; --accent: #8fb5dc; --synthetic: #e8955b; --replay: #5fc1ae; --pass: #6fcf84; --fail: #ef8c7b; --chip-bg: #2a2e34; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #16191d; --fg: #e6e4de; --muted: #9a9ea6; --line: #33373d; --panel: #1e2227; --accent: #8fb5dc; --synthetic: #e8955b; --replay: #5fc1ae; --pass: #6fcf84; --fail: #ef8c7b; --chip-bg: #2a2e34; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font-family: var(--font-body); font-size: 15px; line-height: 1.5; padding-block: 24px 48px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.wrap { max-width: 1040px; margin: 0 auto; display: grid; gap: 20px; }
h1 { font-size: 1.5rem; font-weight: 600; margin: 0; text-wrap: balance; }
h2 { font-size: 1.05rem; font-weight: 600; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 4px 0 0; max-width: 70ch; }
.tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.tab { font: inherit; font-weight: 500; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.tab:hover { border-color: var(--accent); }
.tab[aria-selected="true"] { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.tab:focus-visible, .run:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tab small { display: block; font-weight: 400; opacity: .85; font-size: .8em; }
.runs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); font-size: .9rem; }
.run { font: inherit; font-size: .9rem; background: transparent; color: var(--fg); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.run[aria-selected="true"] { border-color: var(--fg); background: var(--chip-bg); }
.head { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: baseline; }
.verdict { font-size: .8rem; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; padding: 3px 10px; border-radius: 999px; background: var(--chip-bg); }
.verdict.ok { color: var(--pass); } .verdict.bad { color: var(--fail); }
.meta { font-family: var(--font-mono); font-size: .8rem; color: var(--muted); word-break: break-all; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; min-width: 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-top: 1px solid var(--line); }
thead th { border-top: 0; color: var(--muted); font-weight: 500; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
td.t, th.t { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; width: 7.5em; text-align: right; }
td.t .ap { color: var(--muted); }
td.what { font-weight: 500; min-width: 14em; }
td.why { color: var(--muted); min-width: 22em; }
tr.synthetic td.what { color: var(--synthetic); }
tr.replay td.what, tr.captured td.what { color: var(--replay); }
tr.collect td.what, tr.amp td.what { color: var(--accent); }
tr.gap td { background: var(--chip-bg); color: var(--fg); font-style: italic; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: .85rem; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; background: currentColor; }
.legend .s { color: var(--synthetic); } .legend .r { color: var(--replay); } .legend .a { color: var(--accent); }
.note { color: var(--muted); font-size: .9rem; margin: 8px 0 0; max-width: 80ch; }
@media (max-width: 600px) { body { font-size: 14px; } td.why { min-width: 16em; } }
</style>
<div class="wrap">
  <header>
    <h1>Session Replay timing, scenario by scenario</h1>
    <p class="sub">Standalone SDK 1.31.4 + HTTP V2 API, Amplitude project 900970 (US), run 2026-11-06. The right order is Replay Captured first, then the customer\'s amplitude_session_replay event. Every row is a real measurement from one run. Times are milliseconds after the browser started loading page 1; ≈ marks values converted from the Playwright clock, accurate to about 10 ms.</p>
  </header>
  <nav class="tabs" role="tablist" aria-label="Scenario" id="tabs"></nav>
  <div class="runs" id="runs"></div>
  <div class="head"><h2 id="title"></h2><span class="verdict" id="verdict"></span></div>
  <p class="sub" id="plain"></p>
  <p class="meta" id="meta"></p>
  <section>
    <h2>1. What the test server did</h2>
    <div class="scroll"><table><thead><tr><th class="t">Time (ms)</th><th>Server action</th></tr></thead><tbody id="server"></tbody></table></div>
  </section>
  <section>
    <h2>2. What happened in the page, in order</h2>
    <div class="legend"><span class="a">Event sent to Amplitude via the collector</span><span class="s">The customer's synthetic event</span><span class="r">Replay data</span></div>
    <div class="scroll"><table><thead><tr><th class="t">Time (ms)</th><th>Event</th><th>What it is</th></tr></thead><tbody id="page"></tbody></table></div>
  </section>
  <section>
    <h2>3. What Amplitude then showed for this user</h2>
    <div class="scroll"><table><thead><tr><th>Client timestamp (UTC)</th><th>Event in User Lookup</th><th class="t">From page_view</th></tr></thead><tbody id="amp"></tbody></table></div>
    <p class="note" id="replay"></p>
  </section>
</div>
<script>
const DATA = ${JSON.stringify(DATA)};
const $ = (id) => document.getElementById(id);
const fmt = (ms) => Math.round(ms).toLocaleString('en-US');
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let current = { s: DATA.order[0], i: 0 };

function render() {
  const sc = DATA.scenarios[current.s], runs = DATA.runs[current.s], run = runs[current.i];
  for (const b of $('tabs').children) b.setAttribute('aria-selected', b.dataset.s === current.s);
  $('runs').innerHTML = '<span>Runs:</span>' + runs.map((r, i) => '<button class="run" role="tab" data-i="' + i + '" aria-selected="' + (i === current.i) + '">' + r.label + '</button>').join('');
  for (const b of $('runs').querySelectorAll('.run')) b.onclick = () => { current.i = +b.dataset.i; render(); };
  $('title').textContent = 'Scenario ' + sc.n + ': ' + sc.title;
  const ok = /Correct/.test(sc.verdict); $('verdict').textContent = sc.verdict; $('verdict').className = 'verdict ' + (ok ? 'ok' : 'bad');
  $('plain').textContent = sc.plain;
  $('meta').textContent = sc.url + '  ·  device ' + run.device + '  ·  session ' + run.session;
  $('server').innerHTML = sc.server.map(([t, a]) => '<tr><td class="t">' + (typeof t === 'number' ? fmt(t) : t) + '</td><td>' + esc(a) + '</td></tr>').join('');
  $('page').innerHTML = run.rows.map((r) => '<tr class="' + r.kind + '"><td class="t">' + (r.approx ? '<span class="ap">≈</span>' : '') + fmt(r.ms) + '</td><td class="what">' + esc(r.what) + '</td><td class="why">' + esc(r.why) + '</td></tr>').join('');
  let prev = null, html = '';
  for (const e of run.ampRows) {
    const cls = e.e.startsWith('[Amplitude]') ? 'captured' : (e.e.startsWith('amplitude_session_replay') ? 'synthetic' : 'amp');
    html += '<tr class="' + cls + '"><td class="t" style="text-align:left;width:auto">' + e.t + '</td><td class="what">' + esc(e.e) + '</td><td class="t">' + (e.off ? '+' + fmt(e.off) : '0') + '</td></tr>';
  }
  $('amp').innerHTML = html;
  const sr = run.ampRows.find((e) => e.e.startsWith('amplitude_session_replay')), rc = run.ampRows.find((e) => e.e.startsWith('[Amplitude]'));
  let note;
  if (!run.replay) note = 'No replay exists for this device and session: the replay list for the run window has no entry, and User Lookup has no Replay Captured.';
  else {
    note = 'A replay exists. Its start_time in the replay list is ' + run.replay.start + ' (+' + fmt(run.replay.startOff) + ' ms), the same instant as Replay Captured.';
    if (run.replay.firstNav) note += ' The replay\\'s first recorded navigation (the full snapshot, ' + run.replay.firstNav.url + ') is at ' + run.replay.firstNav.t + ' (+' + fmt(run.replay.firstNav.off) + ' ms).';
  }
  if (sr && rc) note += ' Replay Captured is ' + fmt(Math.abs(rc.off - sr.off)) + ' ms ' + (rc.off >= sr.off ? 'after the customer\\'s event. That is the wrong order: Replay Captured should come first.' : 'before the customer\\'s event, which is the right order.');
  $('replay').textContent = note;
}
$('tabs').innerHTML = DATA.order.map((s) => '<button class="tab" role="tab" data-s="' + s + '">Scenario ' + DATA.scenarios[s].n + '<small>' + DATA.scenarios[s].short + '</small></button>').join('');
for (const b of $('tabs').children) b.onclick = () => { current = { s: b.dataset.s, i: 0 }; location.hash = 's' + DATA.scenarios[b.dataset.s].n; render(); };
function fromHash() { const h = location.hash.replace('#s', ''); const s = DATA.order.find((k) => DATA.scenarios[k].n === h); if (s) current = { s, i: 0 }; render(); }
window.addEventListener('hashchange', fromHash);
fromHash();
</script>
`;
fs.writeFileSync('compare.html', html);
fs.writeFileSync('index.html', '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + html.replace('<div class="wrap">', '</head>\n<body>\n<div class="wrap">') + '</body>\n</html>\n');
console.log('wrote compare.html', (html.length / 1024).toFixed(0) + ' KB', Object.entries(byScenario).map(([k, v]) => k + ':' + v.length).join(' '));
