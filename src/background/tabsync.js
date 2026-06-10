// Applies a computed diff via the tabs API. Every mutation we perform is
// marked so the event listeners in main.js can ignore the resulting echoes.

const ECHO_MS = 3000;
const inFlight = new Map(); // tabId -> timeout id
// Pins whose tab creation failed (e.g. privileged about:/file: URLs): skip
// retrying until the pin's URL changes, to avoid per-reconcile churn and spam.
const failedCreates = new Map(); // pinId -> url

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
    if (windowId === null) {
      console.warn("magicPin: no normal window available; skipping", diff.create.length, "create(s)");
    } else {
      for (const { pinId, url, title } of diff.create) {
        if (failedCreates.get(pinId) === url) continue;
        try {
          const tab = await createPinnedTab(windowId, url, title);
          markEcho(tab.id);
          map[tab.id] = pinId;
          failedCreates.delete(pinId);
        } catch (e) {
          // Privileged URLs (about:, file:) can't be created by extensions.
          failedCreates.set(pinId, url);
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
    // Intended for URLs that can't be created discarded, but any create error
    // lands here; the fallback then loads the tab eagerly.
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

// Reorder pinned tabs to match the synced order, per window. Only tabs that
// are actually out of place are moved (and echo-marked) — blanket marking
// would swallow real user unpin/close events for 3s after every reconcile.
async function applyOrder(order, map) {
  const pinToTab = {};
  for (const [tabId, pinId] of Object.entries(map)) pinToTab[pinId] = Number(tabId);

  const tabs = await browser.tabs.query({ pinned: true });
  const eligible = tabs.filter((t) => !t.incognito);
  const byId = new Map(eligible.map((t) => [t.id, t]));

  const perWindow = new Map();
  for (const pinId of order) {
    const tab = byId.get(pinToTab[pinId]);
    if (!tab) continue;
    if (!perWindow.has(tab.windowId)) perWindow.set(tab.windowId, []);
    perWindow.get(tab.windowId).push(tab.id);
  }

  for (const [windowId, desired] of perWindow) {
    // Current left-to-right pinned order in this window, updated as we move.
    const current = eligible
      .filter((t) => t.windowId === windowId)
      .sort((a, b) => a.index - b.index)
      .map((t) => t.id);
    for (let i = 0; i < desired.length; i++) {
      if (current[i] === desired[i]) continue; // already in place
      // markEcho BEFORE the call: our own onMoved event may dispatch before the
      // promise continuation runs. If the move fails, the stray 3s mark can at
      // worst suppress one user reorder, which the next reconcile repairs.
      markEcho(desired[i]);
      try {
        await browser.tabs.move(desired[i], { windowId, index: i });
      } catch {
        // Window may have closed mid-apply; skip.
        continue;
      }
      const from = current.indexOf(desired[i]);
      if (from !== -1) current.splice(from, 1);
      current.splice(i, 0, desired[i]);
    }
  }
}
