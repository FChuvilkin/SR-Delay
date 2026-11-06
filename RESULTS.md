# Results: Session Replay late/missing capture repro

Run on 2026-11-06, 13:33–13:38 UTC, against an Amplitude test project (id 900970, US).
Standalone SDK 1.31.4 from the CDN, events through the HTTP V2 API, Google Chrome (headed) via Playwright, one fresh profile per run.
Server settings: `BODY_HOLD_MS=3000` (the rest of `<body>` held 3 s), `IMG_DELAY_MS=5000` (window `load` at about 8 s).
The 2 s default hold was raised to 3 s because the real remote-config fetch takes 50–1,400 ms, so 2 s left too little margin.

Raw run logs: `results/*.json` (console, network, timing marks, HTTP API responses). Batch log: `results/run-batch.log`.

## Pass criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Scenario 1 in the right order, replay starts immediately | **Fail by 1 ms** (4/4 runs). Replay Captured lands 1 ms *after* the synthetic event. The replay itself does start immediately |
| 2a | Gap shown, `ready_state_at_resolve = "loading"`, replay starting late | **Pass** (3/3). Gap is 2.9 s, not 7 s: `Replay Captured` is stamped at `DOMContentLoaded`, not at `load` (see below) |
| 2b | No replay for page 1 when the user leaves before `load` | **Pass** (3/3). No `Replay Captured`, no replay at all |
| 2c | `Replay Captured` after page 1's `amplitude_session_replay`, replay starts on page 2 | **Pass** (3/3) |
| 3 | Fix restores the order | **Pass** (3/3). The only scenario where `Replay Captured` comes first |

## What Amplitude shows (User Lookup, client timestamps, ms after `page_view`)

### Scenario 1, fast (control)

| Device | `amplitude_session_replay` | `[Amplitude] Replay Captured` | `ready_state_at_resolve` | Replay |
|---|---|---|---|---|
| sr-test-fast-1793972011611 (smoke) | +1,381 | +1,382 | complete | yes, full page from first frame |
| sr-test-fast-1793972062308 | +147 | +148 | complete | yes |
| sr-test-fast-1793972139509 | +155 | +156 | complete | yes |
| sr-test-fast-1793972216753 | +148 | +149 | complete | yes |

Order: `page_view` → `page_timing` → `amplitude_session_replay` → `Replay Captured`. The replay's first upload (about 1 s in) already holds the full snapshot.
**This is the inverted order, by 1 ms.** The right order is `Replay Captured` first. The SDK starts the recorder asynchronously, just after the promise callback has run, so even on a fast page the synthetic event is stamped 1 ms before the recorder's first event. The customer's 50 ms delay covers this case; it does not cover the slow-page case below.

### Scenario 2a, slow page, user stays 20 s

| Device | `amplitude_session_replay` | `Replay Captured` | `DOMContentLoaded` (page mark) | `load` (page mark) | `ready_state_at_resolve` |
|---|---|---|---|---|---|
| sr-test-slow-1793972077580 | +151 | **+3,008** | +3,009 | +8,002 | loading |
| sr-test-slow-1793972154764 | +157 | **+3,011** | +3,012 | +7,999 | loading |
| sr-test-slow-1793972231991 | +157 | **+3,014** | +3,014 | +8,002 | loading |

Order: `page_view` → `amplitude_session_replay` → (2.86 s gap) → `Replay Captured` → `page_timing`.
Every run resolved the promise at about 150 ms with `readyState === "loading"`; the SDK logged "capture beginning" at that moment, but no replay data was uploaded until 8.25 s (right after `load`).

### Scenario 2b, slow page, tab closed at 3 s (before `load`)

| Device | `amplitude_session_replay` | `Replay Captured` | Replay |
|---|---|---|---|
| sr-test-slow-1793972097789 | +162 | **none** | **none** |
| sr-test-slow-1793972175030 | +156 | **none** | **none** |
| sr-test-slow-1793972252185 | +150 | **none** | **none** |

User Lookup holds only `page_view` and `amplitude_session_replay`. The replay list for the window has no entry for these devices.
`DOMContentLoaded` fired at about 3.02 s, 200 ms before the close, but the SDK made **zero** upload requests, so the DCL marker alone never reached Amplitude.

### Scenario 2c, slow page, click through to a fast page at 3 s (same session)

| Device | page 1 `amplitude_session_replay` | page 2 `page_view` | `Replay Captured` | Replay content | Page 2 guard |
|---|---|---|---|---|---|
| sr-test-slow-1793972101009 | +151 | +3,030 | **+3,014** | starts on page 2 (`/?scenario=fast&from=slow` at +3,043) | blocked (localStorage) |
| sr-test-slow-1793972178280 | +171 | +3,025 | **+3,012** | starts on page 2 | blocked |
| sr-test-slow-1793972255444 | +178 | +3,059 | **+3,069** | starts on page 2 | blocked |

Order: `page_view` (p1) → `amplitude_session_replay` (p1) → (2.85 s gap) → `Replay Captured` ≈ page 2 `page_view` → `page_timing` (p2).
The replay's rrweb event list contains one navigation, page 2's URL. Nothing from page 1 is in the replay.
In runs 1 and 2 `Replay Captured` is stamped 13–16 ms *before* page 2's `page_view`: that is page 1's `DOMContentLoaded` marker, kept in IndexedDB and uploaded with page 2's data (same session ID). In run 3 it is page 2's recording start. Either way the inversion from the customer's funnel is reproduced.

### Scenario 3, slow page + fix (wait for `load` + 50 ms when `readyState === "loading"`)

| Device | `Replay Captured` | `page_timing` | `amplitude_session_replay` |
|---|---|---|---|
| sr-test-slow-1793972119194 | +3,000 | +8,020 | **+8,059** |
| sr-test-slow-1793972196515 | +3,014 | +8,021 | **+8,053** |
| sr-test-slow-1793972273672 | +3,015 | +8,024 | **+8,056** |

Order: `page_view` → `Replay Captured` → `page_timing` → `amplitude_session_replay`. Replay exists for all three.

## Answers to the open questions in the handover

1. **The same sequence shows up in Amplitude.** Yes. In every slow run the synthetic event is 2.9 s before `Replay Captured` in User Lookup, and `ready_state_at_resolve` is `"loading"`.
2. **Which timestamp `Replay Captured` uses.** The **first recorded rrweb event**, which is the `DOMContentLoaded` marker, not the full snapshot. In 2a `Replay Captured` is within 1 ms of the page's `DOMContentLoaded` (3.0 s), while the full snapshot and the replay's first navigation are at `load` (8.0 s). So in the player the replay "starts" at 3 s but the first 5 s show nothing. In the fast case the marker and the snapshot coincide, so `Replay Captured` is the moment the recorder started, 1 ms after the promise callback.
   Consequence: the gap the customer sees is **`DOMContentLoaded` minus the moment `init().promise` resolved**, not `load` minus that moment.
3. **Leaving before `load` means no replay for that page, and the replay starts on the next page.** Yes (2b and 2c). The SDK uploaded nothing before the tab closed at 3.2 s, even though the DCL marker had been recorded. With a next page in the same session, the replay begins on that page and `Replay Captured` lands about 3 s after page 1's synthetic event.

## Other observations

- `getSessionReplayProperties()` returned a replay ID at resolve time in every run, including 2b where no replay was ever created. It cannot be used to detect this case.
- The SDK logs "Not able to add custom replay capture event get-sr-props due to no ongoing recording" at resolve time in **every** run, fast ones included, so that log line is not a discriminator either.
- The first upload in the slow runs (8.25 s) carries exactly one event of 112 bytes, the DCL marker; the full snapshot follows in the second upload about 1.5 s later.
- The remote-config fetch took 50–70 ms on a warm connection and 1.4 s on the very first run (cold connection). On page 2 of 2c the config came from the localStorage cache in 2 ms, so `init()` resolves even earlier on later pages.

## Recommendation for the customer (unchanged from the handover, with one refinement)

- Add `ready_state_at_resolve` (`document.readyState` inside `.then()`) to the production `amplitude_session_replay` event. If the inverted sessions are mostly `"loading"`, this mechanism is confirmed.
- Apply the fix from scenario 3: inside `.then()`, if `document.readyState === "loading"`, send the event from a `window` `load` listener (+50 ms); otherwise still delay it by 50–100 ms, because even the fast case is inverted by 1 ms without a delay. Waiting only for `DOMContentLoaded` would put the two events within a few ms of each other, so `load` is the safer anchor and matches the first real frame.
- Gate the event on `getSessionReplayProperties()` returning a replay ID only to cover the separate "remote config failed" cause; it does not catch this one.
- Keep in mind that a user who leaves before `load` will have the synthetic event with no replay at all. That is expected under the fix too, unless the event is sent only after the first replay upload, which the SDK does not expose.
