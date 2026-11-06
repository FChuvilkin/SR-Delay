# Session Replay timing repro (standalone SDK + HTTP V2 API)

Reproduces, with real data in an Amplitude project, why a custom `amplitude_session_replay`
event can land **before** `[Amplitude] Replay Captured` even though it is sent only after
`sessionReplay.init(...).promise` resolves.

Mechanism under test: `init().promise` resolves before rrweb has taken its first snapshot.
If `document.readyState` is still `"loading"` when the SDK calls `record()`, rrweb waits for
window `load` before recording anything, while the synthetic event goes out immediately.

## Files

| File | Role |
|---|---|
| `server.js` | Serves `page.html`, the slow image, and `POST /collect` (stands in for Snowplow + server-side GTM and forwards to the HTTP V2 API). |
| `page.html` | The customer's tag, verbatim apart from: key/URLs templated, `logLevel: 4`, `/collect` instead of `dataLayer.push`, debug properties. |
| `run.js` | Playwright runner, one fresh browser context per run, writes `results/<scenario>-<deviceId>.json`. |
| `.env` | `AMPLITUDE_API_KEY`, `REGION=US|EU`. Not committed. |
| `results/` | One JSON per run (console, network, timing marks, HTTP API responses). |

## Run

```bash
npm install
BODY_HOLD_MS=3000 node run.js --repeat=3          # all scenarios, 3 times each
node run.js 2a-slow-stay                           # one scenario, once
node server.js                                     # just the server, open http://localhost:4321/?scenario=slow
```

Options: `BODY_HOLD_MS` (default 2000) holds the rest of `<body>` so `readyState` stays `loading`;
`IMG_DELAY_MS` (default 5000) delays `/slow.png` so window `load` lands late. `--headless` runs headless.
The runner uses the installed Google Chrome (`channel: 'chrome'`) and falls back to Playwright's Chromium.

## Scenarios

| Name | URL | Reproduces |
|---|---|---|
| `1-fast` | `/?scenario=fast`, stay 15 s | control |
| `2a-slow-stay` | `/?scenario=slow`, stay 20 s | late start: event sent while `readyState === "loading"`, replay starts at `load` |
| `2b-slow-leave` | `/?scenario=slow&leaveAt=3000`, tab closed at 3 s | replay never starts |
| `2c-slow-next` | `/?scenario=slow&leaveAt=3000&next=1`, then `/?scenario=fast` in the same session | replay first appears on page 2, after page 1's event |
| `3-slow-fix` | `/?scenario=slow&fix=1`, stay 20 s | fix: when `readyState === "loading"` at resolve, wait for `load` + 50 ms |

Every run uses a new device ID `sr-test-<scenario>-<timestamp>` and `session_id = Date.now()`;
both are kept in `sessionStorage` so the 2c "next page" stays in the same session.

## Events sent through /collect

- `page_view` immediately, before the SDK runs.
- `amplitude_session_replay` from inside `.promise.then()`, with `ready_state_at_resolve`,
  `ms_at_resolve`, `sr_props` (`getSessionReplayProperties()`), `fix_applied`.
- `page_timing` at window `load` with `dcl_ms`, `load_ms`, `promise_resolved_ms`, `session_replay_event_ms`.

All events carry the browser's `Date.now()` as `time`, a numeric top-level `session_id` and an `insert_id`.

## Comparison page

`node build-compare.js` builds `index.html` (a standalone page, served on GitHub Pages) and `compare.html` from `results/*.json` plus the Amplitude timelines listed at the top of the script. `node serve-compare.js` serves it on http://localhost:8080.

## Results

See `RESULTS.md` for the run log compared with what Amplitude shows.
