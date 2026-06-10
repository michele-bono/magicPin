// Applies a replace plan via the tabs API. Every mutation we perform is
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

// Makes local pinned tabs match a planReplace() plan: create, close, reorder.
// Creates run BEFORE closes: if the only window held only to-be-closed pinned
// tabs, closing first would close the window (or quit the browser) and abort
// the replace half-way.
export async function applyReplace(plan) {
  const windowId = await getTargetWindowId();
  const finalIds = [];
  for (const step of plan.sequence) {
    if (step.tabId !== undefined) {
      finalIds.push(step.tabId);
      continue;
    }
    if (windowId === null) {
      console.warn("magicPin: no normal window available; skipping", step.create.url);
      continue;
    }
    try {
      const tab = await createPinnedTab(windowId, step.create);
      // markEcho lands after the create resolves, so the new tab's very first
      // events can slip through — harmless: they only queue a no-op export.
      markEcho(tab.id);
      finalIds.push(tab.id);
    } catch (e) {
      // Privileged URLs (about:, file:) and containers that don't exist on
      // this device can't be created; skip rather than guess.
      console.warn("magicPin: could not create pinned tab for", step.create.url, e);
    }
  }

  for (const tabId of plan.close) {
    markEcho(tabId);
    try {
      await browser.tabs.remove(tabId);
    } catch {
      // Tab already gone.
    }
  }

  await reorderTo(finalIds);
}

async function createPinnedTab(windowId, { url, title, cookieStoreId }) {
  const base = { windowId, url, pinned: true, active: false };
  if (cookieStoreId) base.cookieStoreId = cookieStoreId;
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

// Reorder pinned tabs to the desired global sequence, per window: kept tabs
// stay in their windows, and only tabs actually out of place are moved (and
// echo-marked) — blanket marking would swallow real user events for 3s.
async function reorderTo(orderedTabIds) {
  const tabs = await browser.tabs.query({ pinned: true });
  const eligible = tabs.filter((t) => !t.incognito);
  const byId = new Map(eligible.map((t) => [t.id, t]));

  const perWindow = new Map();
  for (const tabId of orderedTabIds) {
    const tab = byId.get(tabId);
    if (!tab) continue;
    if (!perWindow.has(tab.windowId)) perWindow.set(tab.windowId, []);
    perWindow.get(tab.windowId).push(tab.id);
  }

  for (const [windowId, desired] of perWindow) {
    const current = eligible
      .filter((t) => t.windowId === windowId)
      .sort((a, b) => a.index - b.index)
      .map((t) => t.id);
    for (let i = 0; i < desired.length; i++) {
      if (current[i] === desired[i]) continue; // already in place
      // markEcho BEFORE the call: our own onMoved event may dispatch before
      // the promise continuation runs.
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
