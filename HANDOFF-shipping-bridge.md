# FWW Shipping — Backend Bug Handoff (`fww-shipping-bridge`)

**For:** a Claude Code session (or engineer) working in the **`fuzzyalex84/fww-shipping-bridge`** repo.
**Date:** 2026-06-22
**Reporter:** Alex (alex@fuzzywumpets.com)

> Paste this whole file into a session that has access to `fww-shipping-bridge`.
> Every bug below lives in the **web app / Cloudflare Worker**, NOT in the desktop
> app. They were diagnosed from the desktop side (`fww-shipping-desktop`), where
> there is no access to this repo or to the Cloudflare account, so nothing here
> could be fixed there.

---

## Architecture (why these are backend bugs)

- The Windows desktop app (`fww-shipping-desktop`) is a **thin Electron shell**.
  It loads the live web UI at `https://shipping.fuzzyreporting.com/ui` on launch
  and runs whatever the worker serves. It does **not** contain the pending-orders
  grid, weight/rate logic, order persistence, label-buying, or batch logic.
- All of that — the UI, the grid, saving weights, fetching rates, buying labels,
  rendering packing slips (`/slip-render`) and labels (`/label`) — is served by
  the **Cloudflare Worker deployed from this repo (`fww-shipping-bridge`)**.
- **Confirm any bug is backend in ~30s:** reproduce it in plain Chrome/Edge at
  `https://shipping.fuzzyreporting.com/ui` (sign in via Cloudflare Access with a
  `@fuzzywumpets.com` account). If it happens in the browser too, it's this repo.

---

## 🔴 Bug 1 — Weight entered on an order does not persist (CRITICAL)

**Symptom:** In the Pending Orders grid, open an order (reproduced on order
**"RICH"**, but others too), enter a weight, the **rate populates correctly**,
then navigate out of the order — and the **weight is blank again**. The value is
not saved.

**Repro:**
1. Pending Orders → open order "RICH".
2. Type a weight. Confirm a rate appears (so the value was accepted client-side).
3. Leave/close the order row.
4. Re-open it → weight is empty.

**Likely area to investigate:**
- The weight-edit handler and whatever persists it (KV / D1 / Durable Object /
  upstream order system). Check whether the PATCH/POST that saves the weight is
  actually being sent and is returning 2xx, or whether the value is only held in
  client state and never written back.
- Check the Worker logs (Cloudflare Observability) for the save request around
  the time of editing — look for a failing/missing write.

---

## Bug 2 — Weight should auto-import but doesn't

**Symptom:** The order should arrive with its weight already populated; it comes
in blank, forcing manual entry (which then hits Bug 1). Lower priority than Bug 1
but related — both touch the weight field's data flow.

---

## Bug 3 — Error highlight doesn't clear after weight/rate is fixed

**Symptom:** A row in Pending Orders is highlighted to flag a missing/invalid
shipping rate or weight. After the weight/rate is corrected (error resolved), the
**highlight should clear** but it persists.

**Likely area:** the grid's row-state/validation logic — the condition that adds
the "error" class isn't being re-evaluated (or cleared) after an update.

---

## Bug 4 — Batch slip print "bounces to top," nothing prints

**Symptom:** Scan/select a batch of orders, click **print batch** → the page
**scrolls back to the top, no confirmation, no error, nothing prints.**

**Important diagnostic context from the desktop side:**
The desktop shell prints packing slips by intercepting how the web app opens the
slip view. It specifically watches for:
- a **new window/tab opened to a `/slip-render` URL** (`window.open(...)`), which
  the shell catches via `setWindowOpenHandler`, **or**
- a **`window.print()` call on a `/slip-render` page**, which the shell intercepts.

When the shell catches either, it renders/print the slip silently. If the batch
button does something **other** than those two things (e.g. an anchor with
`href="#"`, a handler that `preventDefault()`s and scrolls, a `window.open` that
returns `null` in the embedded webview and then bails), the shell never sees it —
which matches the "bounce to top, nothing happens" symptom.

**Action:** check what the **batch** print button actually does vs. the
**single-slip** print button. Single-slip printing is reportedly working; batch
likely uses a different code path that doesn't open `/slip-render` the same way.
Make batch open the same `/slip-render` flow (with all selected order IDs) that
single-slip uses.

> NOTE: open the app's DevTools (the desktop app has **F12 → Console**) and click
> batch print to see exactly what it tries to do / what errors.

---

## Bug 5 — Label buying/printing is extraordinarily slow

**Symptom:** Buying + printing labels is very slow.

**Need to localize (ask Alex which half):**
- **Buying slow** (waiting after clicking buy for the label to come back) →
  backend: the worker's call to the shipping carrier's rate/label API. Check
  Worker logs for the `/label` request duration; look for slow upstream calls,
  retries, or sequential calls that could be parallelized.
- **Printing slow** (label returns fast but is slow to hit the printer) → that's
  desktop-side and tracked separately in `fww-shipping-desktop`.

---

## Bug 6 — Print labels in order-number order

**Request:** When printing labels (esp. in a batch), print them sorted by
**order number**. Currently they don't come out in order. This is a sort applied
wherever the batch label set is assembled/emitted by the worker.

---

## Desktop-side status (FYI — already handled, separate repo)

For context, the desktop shell (`fww-shipping-desktop`) had its own printing bugs
that ARE fixed and shipped, so don't chase these here:
- **v1.0.8** — reworked packing-slip auto-print (was spinning forever / never
  printing). Also fixed the GitHub Actions release pipeline (the `GITHUB_TOKEN`
  was read-only → release publish 403'd; repo Actions permission set to
  read/write fixed it).
- **v1.0.9** — fixed packing slips printing as a **solid black page** (the app
  forces dark mode; an intermediate PDF was being reprinted through Chromium's
  dark PDF viewer with `printBackground`). v1.0.9 prints the slip HTML directly.
- **Known desktop follow-ups:** the release uploads a duplicate `.exe` (two
  publishers in the workflow) which appears to confuse electron-updater's
  auto-update; recommend collapsing to a single publisher. Auto-update has been
  unreliable, so installs have been manual.

These are in the **desktop** repo, not this one.

---

## Suggested order of attack

1. **Bug 1 (weight not persisting)** — critical, blocks daily work.
2. **Bug 3 (highlight not clearing)** — same grid area, likely related.
3. **Bug 4 (batch print)** — see the `/slip-render` handoff notes above.
4. **Bug 6 (label order)** + **Bug 2 (weight auto-import)** — smaller.
5. **Bug 5 (label speed)** — confirm buying-vs-printing half first.

Use Cloudflare Workers Observability logs alongside the source to confirm each
fix against real requests.
