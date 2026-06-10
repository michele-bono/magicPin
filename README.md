# magicPin

Firefox extension that keeps a saved copy of **each device's pinned tabs** in
your Firefox Account, and lets you replace this device's pinned tabs with any
other device's set in one click.

Built on `browser.storage.sync`: no servers, no extra accounts, encrypted by
Firefox Sync. Data travels on Firefox's sync schedule (typically within
minutes; immediately on browser startup/focus in practice).

## Requirements

- Firefox 115+ on every device
- Signed into the same Firefox Account with Sync enabled (and "Add-ons"
  syncing on, so the extension itself can be installed everywhere)
- magicPin installed on every device

## How it behaves

- **Each device saves its own set, automatically.** Pinning, unpinning,
  closing, reordering, and navigating inside pinned tabs update this device's
  saved set in the background (debounced). Nothing on your screen ever
  changes by itself.
- **One saved version per device.** The popup lists every device with its
  saved pins, names, and when it last saved.
- **Replace from any device.** Each other device has a **Replace** button
  (click twice — it closes tabs) that makes this device's pinned tabs match
  that device's saved set: tabs that already match are kept (no reload),
  missing pins are created lazily (discarded), everything else is closed, and
  the order is matched. The adopted set immediately becomes this device's
  saved set too.
- **Containers respected:** the same URL pinned in different Firefox
  containers is two distinct pins (marked ▣ in the popup), and Replace
  recreates each pin in its container.
- **Sync now** saves this device's current set immediately, skipping the
  debounce. Note the transfer to/from the sync server itself stays on
  Firefox's schedule — use the Firefox account menu's "Sync Now" to force
  that part.
- **Rename / forget:** click this device's name in the popup to rename it;
  forget (✕) removes a stale device's saved set.
- **Pause** stops this device from saving (per-device). A red `!` badge means
  the last save failed.

## Known limitations

- If Firefox Sync is disabled, `storage.sync` silently stays local-only —
  Firefox offers no API to detect this.
- Privileged pins (`about:*`, `file:*`) can't be recreated by extensions and
  are skipped during Replace.
- A device's saved set must fit in one sync record (~8 KB ≈ 40+ pins
  depending on URL length).
- Container pins are recreated in the same container. Firefox's four built-in
  containers match across devices; user-created containers have per-profile
  IDs, so on another device the pin may open in whichever container has that
  ID, or be skipped if none does.
- Replace overwrites this device's own saved set with the adopted one (the
  saved set always mirrors the device's current pinned tabs).

## Development

```bash
npm install
npm test        # vitest unit tests (pure pin-set logic)
npm run lint    # web-ext lint
npm start       # web-ext run (temporary profile)
```

## Manual E2E checklist (two profiles, same Firefox Account)

Set up two Firefox profiles (`about:profiles`), sign both into the same
account with Sync on, and load the extension in both (`about:debugging` →
Load Temporary Add-on, or an unsigned build via `web-ext build` on
Developer Edition). Force syncs from the account menu → "Sync now" to avoid
waiting for the schedule. Then verify:

1. **Save propagates:** pin a tab in profile A, wait ~2s, Sync now in both →
   A's device row in B's popup shows the pin.
2. **Replace:** in B, click Replace on A's row (twice) → B's pinned tabs
   become A's set; tabs B already had that match are not reloaded; B's own
   saved set now equals the adopted set.
3. **Containers:** pin the same site in two containers in A, Sync now,
   Replace in B → two pinned tabs in B, each in its container; neither
   disappears.
4. **Navigation:** browse inside a pinned tab in A → after ~10s A's saved set
   shows the new URL; B is untouched until Replace.
5. **Rename / forget:** rename A via its name field → B's popup shows the new
   name after a sync. Forget a stale device in B → its row disappears
   everywhere after a sync.
6. **Pause:** pause A, pin a tab → A's saved set doesn't change; unpause →
   it saves immediately.
