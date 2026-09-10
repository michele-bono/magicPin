// Applies a replace plan via the tabs API. Resulting events queue a save
// behind the mutation; identity comparison makes unchanged saves no-ops.

// Makes local pinned tabs match a planReplace() plan: create, close, reorder.
// Creates run BEFORE closes: if the only window held only to-be-closed pinned
// tabs, closing first would close the window (or quit the browser) and abort
// the replace half-way. Returns the number of pins that couldn't be opened.
export async function applyReplace(plan) {
  const windowId = await getTargetWindowId();
  const finalIds = [];
  let failed = 0;
  for (const step of plan.sequence) {
    if (step.tabId !== undefined) {
      finalIds.push(step.tabId);
      continue;
    }
    if (windowId === null) {
      console.warn("magicPin: no normal window available; skipping", step.create.url);
      failed++;
      continue;
    }
    try {
      const tab = await createPinnedTab(windowId, step.create);
      finalIds.push(tab.id);
    } catch (e) {
      // Privileged URLs (about:, file:) and containers that don't exist on
      // this device can't be created; skip rather than guess.
      console.warn("magicPin: could not create pinned tab for", step.create.url, e);
      failed++;
    }
  }

  for (const tabId of plan.close) {
    try {
      await browser.tabs.remove(tabId);
    } catch {
      // Tab already gone.
    }
  }

  await reorderTo(finalIds);
  return failed;
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
// stay in their windows, and only tabs actually out of place are moved.
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
