import { computeDiff, computeLocalOrder, navUpdates } from "./reconcile.js";
import { applyDiff, isEcho } from "./tabsync.js";
import * as store from "./store.js";
import { debounce } from "./util.js";

// ---------- helpers ----------

async function getLocalPinnedTabs() {
  const tabs = await browser.tabs.query({ pinned: true });
  return tabs
    .filter((t) => !t.incognito)
    .map((t) => ({
      tabId: t.id,
      url: t.url,
      title: t.title ?? "",
      index: t.index,
      windowId: t.windowId,
    }));
}

async function setErrorBadge() {
  await browser.action.setBadgeText({ text: "!" });
  await browser.action.setBadgeBackgroundColor({ color: "#d7263d" });
}

async function clearErrorBadge() {
  await browser.action.setBadgeText({ text: "" });
}

// ---------- reconcile (remote -> local, plus first-run/offline uploads) ----------

let reconciling = false;
let reconcileQueued = false;

async function reconcile() {
  if (reconciling) {
    reconcileQueued = true;
    return;
  }
  reconciling = true;
  try {
    if (await store.readPaused()) return;
    await store.ensureSchema();

    const remote = await store.readRemote();
    const snapshot = await store.readSnapshot();
    const tabMap = await store.readTabMap();
    const localTabs = await getLocalPinnedTabs();

    const diff = computeDiff({ remote, localTabs, snapshot, tabMap });
    let map = await applyDiff(diff);

    // Upload locally-new pins (first run, offline-created, fresh pin events).
    const pins = { ...remote.pins };
    const order = [...diff.order];
    if (diff.upload.length) {
      const set = {};
      for (const u of diff.upload) {
        const id = crypto.randomUUID();
        set[id] = { url: u.url, title: u.title, updatedAt: Date.now() };
        pins[id] = set[id];
        order.push(id);
        map[u.tabId] = id;
      }
      await store.writePins({ set, order });
    }

    // Drop map entries for tabs that no longer exist (incl. ones we just closed).
    const live = new Set((await getLocalPinnedTabs()).map((t) => t.tabId));
    map = Object.fromEntries(
      Object.entries(map).filter(([tabId]) => live.has(Number(tabId)))
    );

    await store.writeTabMap(map);
    await store.writeSnapshot({ pins, order });
    await store.writeLastSync(Date.now());
    await clearErrorBadge();
  } catch (e) {
    console.error("magicPin: reconcile failed", e);
    await setErrorBadge();
  } finally {
    reconciling = false;
    if (reconcileQueued) {
      reconcileQueued = false;
      scheduleReconcile();
    }
  }
}

const scheduleReconcile = debounce(reconcile, 500);

// ---------- local -> remote: deletions ----------

async function removePin(pinId) {
  if (await store.readPaused()) return;
  try {
    const remote = await store.readRemote();
    await store.writePins({
      remove: [pinId],
      order: remote.order.filter((id) => id !== pinId),
    });
    const snapshot = await store.readSnapshot();
    delete snapshot.pins[pinId];
    snapshot.order = snapshot.order.filter((id) => id !== pinId);
    await store.writeSnapshot(snapshot);
    await store.writeLastSync(Date.now());
  } catch (e) {
    console.error("magicPin: failed to sync pin removal", e);
    await setErrorBadge();
  }
}

async function handleLocalPinGone(tabId) {
  const tabMap = await store.readTabMap();
  const pinId = tabMap[tabId];
  if (!pinId) return;
  delete tabMap[tabId];
  await store.writeTabMap(tabMap);
  await removePin(pinId);
}

// ---------- local -> remote: order ----------

const schedulePushOrder = debounce(async () => {
  if (await store.readPaused()) return;
  try {
    const tabMap = await store.readTabMap();
    const order = computeLocalOrder(await getLocalPinnedTabs(), tabMap);
    await store.writePins({ order });
    const snapshot = await store.readSnapshot();
    snapshot.order = order;
    await store.writeSnapshot(snapshot);
  } catch (e) {
    console.error("magicPin: failed to sync order", e);
    await setErrorBadge();
  }
}, 1500);

// ---------- local -> remote: navigation (merge-on-write) ----------

const navigatedPins = new Set();

const scheduleNavFlush = debounce(async () => {
  if (await store.readPaused()) return;
  const navigatedPinIds = [...navigatedPins];
  navigatedPins.clear();
  try {
    const tabMap = await store.readTabMap();
    const remote = await store.readRemote();
    const set = navUpdates({
      navigatedPinIds,
      tabMap,
      localTabs: await getLocalPinnedTabs(),
      remotePins: remote.pins,
      now: Date.now(),
    });
    if (!Object.keys(set).length) return;
    await store.writePins({ set });
    const snapshot = await store.readSnapshot();
    Object.assign(snapshot.pins, set);
    await store.writeSnapshot(snapshot);
    await store.writeLastSync(Date.now());
  } catch (e) {
    console.error("magicPin: failed to sync navigation", e);
    await setErrorBadge();
  }
}, 10000);

// ---------- event wiring (top level, so events wake the event page) ----------

browser.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    if (isEcho(tabId) || tab.incognito) return;
    if (changeInfo.pinned === true) scheduleReconcile(); // new local pin -> upload
    if (changeInfo.pinned === false) await handleLocalPinGone(tabId);
    if (changeInfo.url && tab.pinned) {
      const tabMap = await store.readTabMap();
      if (tabMap[tabId]) {
        navigatedPins.add(tabMap[tabId]);
        scheduleNavFlush();
      }
    }
  },
  { properties: ["pinned", "url"] }
);

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // A closing window (or browser shutdown) is NOT a user unpin.
  if (isEcho(tabId) || removeInfo.isWindowClosing) return;
  await handleLocalPinGone(tabId);
});

browser.tabs.onMoved.addListener(async (tabId) => {
  if (isEcho(tabId)) return;
  const tabMap = await store.readTabMap();
  if (tabMap[tabId]) schedulePushOrder();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") scheduleReconcile();
});

browser.runtime.onStartup.addListener(() => scheduleReconcile());
browser.runtime.onInstalled.addListener(() => scheduleReconcile());
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== browser.windows.WINDOW_ID_NONE) scheduleReconcile();
});
