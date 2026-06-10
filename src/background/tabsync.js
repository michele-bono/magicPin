// Applies a computed diff via the tabs API. Every mutation we perform is
// marked so the event listeners in main.js can ignore the resulting echoes.

const ECHO_MS = 3000;
const inFlight = new Map(); // tabId -> timeout id

export function markEcho(tabId) {
  clearTimeout(inFlight.get(tabId));
  inFlight.set(
    tabId,
    setTimeout(() => inFlight.delete(tabId), ECHO_MS)
  );
}

export function isEcho(tabId) {
  return inFlight.has(tabId);
}

// Applies close/create/order. Returns the updated { tabId: pinId } map.
export async function applyDiff(diff) {
  const map = { ...diff.map };

  for (const tabId of diff.close) {
    markEcho(tabId);
    try {
      await browser.tabs.remove(tabId);
    } catch {
      // Tab already gone.
    }
  }

  if (diff.create.length) {
    const windowId = await getTargetWindowId();
    if (windowId !== null) {
      for (const { pinId, url, title } of diff.create) {
        try {
          const tab = await createPinnedTab(windowId, url, title);
          markEcho(tab.id);
          map[tab.id] = pinId;
        } catch (e) {
          // Privileged URLs (about:, file:) can't be created by extensions.
          console.warn("magicPin: could not create pinned tab for", url, e);
        }
      }
    }
  }

  await applyOrder(diff.order, map);
  return map;
}

async function createPinnedTab(windowId, url, title) {
  const base = { windowId, url, pinned: true, active: false };
  try {
    // discarded:true = lazy tab; N incoming pins don't trigger N page loads.
    return await browser.tabs.create({ ...base, discarded: true, title });
  } catch {
    // Some URLs can't be created discarded; fall back to a normal load.
    return await browser.tabs.create(base);
  }
}

async function getTargetWindowId() {
  const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
  const candidates = wins.filter((w) => !w.incognito);
  if (!candidates.length) return null;
  const focused = candidates.find((w) => w.focused);
  return (focused ?? candidates[0]).id;
}

// Reorder pinned tabs to match the synced order, per window.
async function applyOrder(order, map) {
  const pinToTab = {};
  for (const [tabId, pinId] of Object.entries(map)) pinToTab[pinId] = Number(tabId);

  const tabs = await browser.tabs.query({ pinned: true });
  const byId = new Map(tabs.filter((t) => !t.incognito).map((t) => [t.id, t]));

  const perWindow = new Map();
  for (const pinId of order) {
    const tab = byId.get(pinToTab[pinId]);
    if (!tab) continue;
    if (!perWindow.has(tab.windowId)) perWindow.set(tab.windowId, []);
    perWindow.get(tab.windowId).push(tab.id);
  }

  for (const [windowId, tabIds] of perWindow) {
    for (let i = 0; i < tabIds.length; i++) {
      markEcho(tabIds[i]);
      try {
        await browser.tabs.move(tabIds[i], { windowId, index: i });
      } catch {
        // Window may have closed mid-apply; skip.
      }
    }
  }
}
