// Pure pin-set logic. No browser API access — keep it unit-testable.
//
// Each device saves its own ordered pin list to storage.sync; nothing is
// merged across devices, so a pin record is just { url, title,
// cookieStoreId? }. Pin identity is (url, container): the same URL pinned in
// two Firefox containers is two distinct pins. A missing cookieStoreId means
// the default container.

const containerOf = (x) => x.cookieStoreId ?? "firefox-default";
const sameIdentity = (a, b) => a.url === b.url && containerOf(a) === containerOf(b);
// Spread helper: only non-default containers are stored on records.
const containerField = (x) =>
  x.cookieStoreId && x.cookieStoreId !== "firefox-default"
    ? { cookieStoreId: x.cookieStoreId }
    : {};

// Ordered, syncable snapshot of this device's pinned tabs: by window, then
// left-to-right tab index.
export function serializePins(localTabs) {
  return [...(localTabs ?? [])]
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
    .map((t) => ({ url: t.url, title: t.title ?? "", ...containerField(t) }));
}

// Identity-sequence equality. Titles are deliberately ignored: pinned app
// tabs mutate their titles constantly ("(2) Inbox"), and exporting on every
// title change would burn the storage.sync write quota. Titles still refresh
// whenever a structural or URL change triggers an export.
export function pinsEqual(a, b) {
  a = a ?? [];
  b = b ?? [];
  if (a.length !== b.length) return false;
  return a.every((p, i) => sameIdentity(p, b[i]));
}

// Plan to make local pinned tabs match a target pin list. Tabs that already
// match by identity are reused (no reload); the rest are closed. Returns:
//   close:    [tabId, ...]
//   sequence: [{ tabId } | { create: {url, title, cookieStoreId?} }, ...]
//             — the desired final left-to-right pin order.
export function planReplace(localTabs, target) {
  const unused = [...(localTabs ?? [])];
  const sequence = [];
  for (const want of target ?? []) {
    const i = unused.findIndex((t) => sameIdentity(t, want));
    if (i !== -1) {
      sequence.push({ tabId: unused[i].tabId });
      unused.splice(i, 1);
    } else {
      sequence.push({ create: { url: want.url, title: want.title, ...containerField(want) } });
    }
  }
  return { close: unused.map((t) => t.tabId), sequence };
}
