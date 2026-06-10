// Pure diff/merge logic. No browser API access — keep it unit-testable.

// Pin identity is (url, container): the same URL pinned in two Firefox
// containers is two distinct pins. Records without cookieStoreId (pre-container
// schema) mean the default container.
const containerOf = (x) => x.cookieStoreId ?? "firefox-default";
const sameIdentity = (a, b) => a.url === b.url && containerOf(a) === containerOf(b);
// Spread helper: only non-default containers are stored on records.
export const containerField = (x) =>
  x.cookieStoreId && x.cookieStoreId !== "firefox-default"
    ? { cookieStoreId: x.cookieStoreId }
    : {};

export function computeDiff({ remote, localTabs, snapshot, tabMap }) {
  const remotePins = remote.pins ?? {};
  const snapshotPins = snapshot.pins ?? {};
  tabMap = tabMap ?? {};
  const map = {};
  const matched = new Set();
  const unmatched = [];

  // Pass 1: match by existing tabId -> pinId mapping (survives navigation).
  for (const tab of localTabs) {
    const pinId = tabMap[tab.tabId];
    if (pinId && remotePins[pinId] && !matched.has(pinId)) {
      map[tab.tabId] = pinId;
      matched.add(pinId);
    } else {
      unmatched.push(tab);
    }
  }

  // Pass 2: match by identity (covers session restore, fresh installs).
  const leftover = [];
  for (const tab of unmatched) {
    const pinId = Object.keys(remotePins).find(
      (id) => !matched.has(id) && sameIdentity(remotePins[id], tab)
    );
    if (pinId) {
      map[tab.tabId] = pinId;
      matched.add(pinId);
    } else {
      leftover.push(tab);
    }
  }

  // Three-way deletion detection: distinguish remote deletions from offline-created pins.
  const close = [];
  const upload = [];
  for (const tab of leftover) {
    const pinId = tabMap[tab.tabId];
    if (pinId && snapshotPins[pinId] && !remotePins[pinId]) {
      // It synced before and another device deleted it: mirror the deletion.
      close.push(tab.tabId);
    } else {
      // No mapping, or pin not in snapshot (never synced / stale mapping): upload as new.
      upload.push({ tabId: tab.tabId, url: tab.url, title: tab.title, ...containerField(tab) });
    }
  }

  const create = Object.entries(remotePins)
    .filter(([id]) => !matched.has(id))
    .map(([pinId, p]) => ({ pinId, url: p.url, title: p.title, ...containerField(p) }));

  const order = (remote.order ?? []).filter((id) => remotePins[id]);

  return { create, close, upload, map, order };
}

// Global pin order from local tabs: by window, then left-to-right tab index.
// tabMap: { [tabId]: pinId }
export function computeLocalOrder(localTabs, tabMap) {
  if (!localTabs?.length) return [];
  return [...localTabs]
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
    .map((t) => tabMap[t.tabId])
    .filter(Boolean);
}

// Collapse remote pins that share an identity (url + container) — the artifact
// of two devices concurrently uploading the same pin on first run. Every device
// keeps the lexicographically smallest id, so they all converge on the same
// survivor. Same URL in different containers is two distinct pins and is kept.
// (Intentionally still collapses user-created same-url-same-container
// duplicates; v1 trade-off.)
export function dedupeRemotePins(remotePins) {
  const byUrl = new Map();
  for (const [id, p] of Object.entries(remotePins ?? {})) {
    // URLs cannot contain raw spaces, so "container url" is an unambiguous key.
    const key = `${containerOf(p)} ${p.url}`;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(id);
  }
  const remove = [];
  for (const ids of byUrl.values()) {
    if (ids.length < 2) continue;
    ids.sort();
    remove.push(...ids.slice(1));
  }
  return remove;
}

// Merge-on-write: build url updates ONLY for pins this device navigated,
// so a stale device never clobbers another device's fresher urls.
// Assumes tabMap is injective (one tabId per pinId), which computeDiff guarantees.
export function navUpdates({ navigatedPinIds, tabMap, localTabs, remotePins, now }) {
  const pinToTab = {};
  for (const [tabId, pinId] of Object.entries(tabMap)) pinToTab[pinId] = Number(tabId);
  const tabsById = new Map(localTabs.map((t) => [t.tabId, t]));
  const set = {};
  for (const pinId of navigatedPinIds) {
    const tab = tabsById.get(pinToTab[pinId]);
    const existing = remotePins[pinId];
    if (!tab || !existing || existing.url === tab.url) continue;
    // Carry the pin's container through: a nav update must not strip identity.
    set[pinId] = { url: tab.url, title: tab.title, updatedAt: now, ...containerField(existing) };
  }
  return set;
}

// Manual-apply bookkeeping: the snapshot tracks pins this device has
// ACKNOWLEDGED (applied or uploaded), not just the latest remote state.
// A pin deleted remotely but still open locally stays in the snapshot as a
// "pending removal" until the user applies — so the auto path neither closes
// the tab (apply is manual) nor re-uploads it (which would resurrect the
// deletion). Deleted pins nothing references anymore are garbage-collected.
export function carrySnapshot({ snapshot, remote, uploaded, tabMap }) {
  const remotePins = remote.pins ?? {};
  const referenced = new Set(Object.values(tabMap ?? {}));
  const pins = {};
  for (const [id, p] of Object.entries(snapshot.pins ?? {})) {
    if (!remotePins[id] && referenced.has(id)) pins[id] = p; // pending removal
  }
  Object.assign(pins, remotePins, uploaded ?? {});
  return { pins, order: remote.order ?? [] };
}
