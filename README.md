# magicPin

Firefox extension that syncs your pinned tabs across every device signed
into the same Firefox Account — pins, unpins, reorders, and navigation upload
automatically; each device imports the synced set with one click.

Built on `browser.storage.sync`: no servers, no extra accounts, encrypted by
Firefox Sync. Changes propagate on Firefox's sync schedule (typically within
minutes; immediately on browser startup/focus in practice).

## Requirements

- Firefox 115+ on every device
- Signed into the same Firefox Account with Sync enabled (and "Add-ons"
  syncing on, so the extension itself can be installed everywhere)
- magicPin installed on every device

## How it behaves

- **Your changes upload automatically:** pinning, unpinning, closing,
  reordering, and navigating inside pinned tabs all update the synced set in
  the background. Nothing on your screen ever changes by itself.
- **Importing is manual:** the toolbar popup's **"Replace pinned tabs with
  synced set"** button makes this device's pinned tabs match the synced set
  exactly — missing pins are created, pins removed elsewhere are closed, and
  the order is matched. Until you click it, incoming changes only show in the
  popup list.
- **One global set:** pins from all your windows merge into a single synced
  list; on apply, incoming pins open in the most recently focused window.
- **Navigation follows you without reloading:** the stored URL tracks where
  you browsed, so applying on another device opens the pin where you left
  off — but pinned tabs already open are never reloaded under you.
- **Lazy loading:** applied pins are created discarded, so ten pins don't
  trigger ten page loads.
- **Containers respected:** the same URL pinned in different Firefox
  containers is two distinct pins, and applying recreates each pin in its
  container.
- **Pause:** the toolbar popup has a per-device pause toggle (it also disables
  the replace button). A red `!` badge means the last sync write failed.

## Known limitations

- If Firefox Sync is disabled, `storage.sync` silently stays local-only —
  Firefox offers no API to detect this.
- Privileged pins (`about:*`, `file:*`) can't be recreated by extensions and
  are skipped on other devices.
- Pin deletions are propagated from live unpin/close events; a deletion that
  happens while the extension is not running is re-created rather than lost
  (the design errs on the side of never losing a pin).
- Two pinned tabs with the same URL **in the same container** collapse into
  one synced pin: identical URLs are how concurrent first-run uploads from
  different devices are deduplicated, and that rule can't tell an intentional
  duplicate apart. The same URL in different Firefox containers is treated as
  distinct pins and syncs fine.
- Container pins are recreated in the same container on other devices. If a
  (custom) container doesn't exist on a device, that pin is skipped there —
  Firefox's four built-in containers always match across devices, but
  user-created containers don't share IDs unless a container-sync add-on is
  used.

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

1. **Pin propagates:** pin a tab in profile A, Sync now in both → it shows in
   B's popup list; click **Replace pinned tabs with synced set** in B → it
   appears pinned (lazy). B's other tabs are untouched only if they were
   already synced.
2. **Unpin removes on apply:** unpin it in profile B, Sync now → it leaves A's
   popup list but A's tab stays open until A clicks Replace, which closes it.
   It stays open unpinned in B.
3. **Reorder:** with 3 pins, drag to reorder in A, Sync now, Replace in B →
   same order in B.
4. **Navigation, no reload:** navigate inside a pinned tab in A, Sync now →
   B's already-open pinned tab does NOT reload, but B's popup shows the
   updated URL (applying on a device without that pin opens the new URL).
5. **Offline pin survives:** disconnect A's network, pin a new tab, reconnect,
   Sync now → the new pin uploads and shows in B's popup; nothing gets closed.
6. **Containers:** pin the same site in two containers in A, Sync now, Replace
   in B → two pinned tabs in B, each in its container; neither disappears.
7. **Pause:** pause B via popup (Replace disables), pin a tab in A, Sync now →
   B unchanged; unpause B → B's uploads resume, importing still waits for the
   button.
