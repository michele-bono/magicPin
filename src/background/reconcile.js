// Pure diff/merge logic. No browser API access — keep it unit-testable.

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

  // Pass 2: match by exact URL (covers session restore, fresh installs).
  const leftover = [];
  for (const tab of unmatched) {
    const pinId = Object.keys(remotePins).find(
      (id) => !matched.has(id) && remotePins[id].url === tab.url
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
      upload.push({ tabId: tab.tabId, url: tab.url, title: tab.title });
    }
  }

  const create = Object.entries(remotePins)
    .filter(([id]) => !matched.has(id))
    .map(([pinId, p]) => ({ pinId, url: p.url, title: p.title }));

  const order = (remote.order ?? []).filter((id) => remotePins[id]);

  return { create, close, upload, map, order };
}
