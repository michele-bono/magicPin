# magicPin

Firefox extension that mirrors your pinned tabs across every device signed
into the same Firefox Account — pin a tab anywhere, it appears pinned
everywhere; unpin or close it anywhere, it closes everywhere.

Built on `browser.storage.sync`: no servers, no extra accounts, encrypted by
Firefox Sync. Changes propagate on Firefox's sync schedule (typically within
minutes; immediately on browser startup/focus in practice).

## Requirements

- Firefox 115+ on every device
- Signed into the same Firefox Account with Sync enabled (and "Add-ons"
  syncing on, so the extension itself can be installed everywhere)
- magicPin installed on every device

## How it behaves

- **One global set:** pins from all your windows merge into a single synced
  list; incoming pins open in the most recently focused window.
- **Unpin/close anywhere = remove everywhere.** Unpinning keeps the tab open
  (unpinned) on the device where you did it, and closes it on the others.
- **Navigation follows you without reloading:** the stored URL tracks where
  you browsed, so a device opening the pin fresh starts there — but pinned
  tabs already open on other devices are never reloaded under you.
- **Lazy loading:** incoming pins are created discarded, so ten pins don't
  trigger ten page loads.
- **Pause:** the toolbar popup has a per-device pause toggle. A red `!` badge
  means the last sync write failed.

## Known limitations

- If Firefox Sync is disabled, `storage.sync` silently stays local-only —
  Firefox offers no API to detect this.
- Privileged pins (`about:*`, `file:*`) can't be recreated by extensions and
  are skipped on other devices.
- Pin deletions are propagated from live unpin/close events; a deletion that
  happens while the extension is not running is re-created rather than lost
  (the design errs on the side of never losing a pin).
- Two pinned tabs with the same URL collapse into one synced pin: identical
  URLs are how concurrent first-run uploads from different devices are
  deduplicated, and that rule can't tell an intentional duplicate apart.

## Development

```bash
npm install
npm test        # vitest unit tests (pure diff/merge logic)
npm run lint    # web-ext lint
npm start       # web-ext run (temporary profile)
```

## Manual E2E checklist (two profiles, same Firefox Account)

Set up two Firefox profiles (`about:profiles`), sign both into the same
account with Sync on, and load the extension in both (`about:debugging` →
Load Temporary Add-on, or an unsigned build via `web-ext build` on
Developer Edition). Force syncs from the account menu → "Sync now" to avoid
waiting for the schedule. Then verify:

1. **Pin propagates:** pin a tab in profile A, Sync now in both → appears
   pinned (lazy) in profile B.
2. **Unpin closes:** unpin it in profile B, Sync now → it closes in A, stays
   open unpinned in B.
3. **Reorder:** with 3 pins, drag to reorder in A, Sync now → same order in B.
4. **Navigation, no reload:** navigate inside a pinned tab in A, Sync now →
   B's already-open pinned tab does NOT reload, but B's popup shows the
   updated URL (a device opening the pin fresh would start there).
5. **Offline pin survives:** disconnect A's network, pin a new tab, reconnect,
   Sync now → the new pin uploads and appears in B; nothing gets closed.
6. **Pause:** pause B via popup, pin a tab in A, Sync now → B unchanged;
   unpause B → B catches up immediately.
