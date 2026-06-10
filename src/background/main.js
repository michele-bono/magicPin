import { computeDiff, computeLocalOrder, navUpdates, dedupeRemotePins } from "./reconcile.js";
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

// All storage-mutating work runs on one promise chain, so reconcile and the
// local-change handlers never interleave their read-modify-writes of
// tabMap/snapshot/order.
let chain = Promise.resolve();
function serialize(fn) {
  return (...args) => {
    const run = chain.then(() => fn(...args));
    chain = run.catch(() => {});
    return run;
  };
}

// ---------- restart-proof tab identity ----------
// storage.session is cleared when the browser quits, but session-restored tabs
// keep their sessions API values. Persisting tabId -> pinId there lets a
// restored pinned tab that navigated before its nav flush keep its identity
// instead of being re-uploaded as a duplicate.

async function persistAssociations(map) {
  await Promise.all(
    Object.entries(map).map(([tabId, pinId]) =>
      browser.sessions.setTabValue(Number(tabId), "pinId", pinId).catch(() => {})
    )
  );
}

async function adoptPersistedAssociations(localTabs, tabMap, remotePins) {
  const mapped = new Set(Object.values(tabMap));
  for (const tab of localTabs) {
    if (tabMap[tab.tabId]) continue;
    const pinId = await browser.sessions
      .getTabValue(tab.tabId, "pinId")
      .catch(() => undefined);
    if (pinId && remotePins[pinId] && !mapped.has(pinId)) {
      tabMap[tab.tabId] = pinId;
      mapped.add(pinId);
    }
  }
}

// ---------- reconcile (remote -> local, plus first-run/offline uploads) ----------

const reconcile = serialize(async () => {
  try {
    if (await store.readPaused()) return;
    await store.ensureSchema();

    let remote = await store.readRemote();

    // Converge concurrent first-run uploads: identical-URL pins collapse to
    // the same survivor on every device.
    const dupIds = dedupeRemotePins(remote.pins);
    if (dupIds.length) {
      await store.writePins({
        remove: dupIds,
        order: remote.order.filter((id) => !dupIds.includes(id)),
      });
      remote = await store.readRemote();
    }

    const snapshot = await store.readSnapshot();
    const tabMap = await store.readTabMap();
    const localTabs = await getLocalPinnedTabs();
    await adoptPersistedAssociations(localTabs, tabMap, remote.pins);

    const diff = computeDiff({ remote, localTabs, snapshot, tabMap });
    let map = await applyDiff(diff);

    // Upload locally-new pins (first run, offline-created, fresh pin events).
    // A pin-then-quick-unpin inside the debounce window may still upload and
    // be re-created once; sub-second window, recoverable by closing the tab.
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
      await store.writeLastSync(Date.now());
    }

    // Drop map entries for tabs that no longer exist (incl. ones we just closed).
    const live = new Set((await getLocalPinnedTabs()).map((t) => t.tabId));
    map = Object.fromEntries(
      Object.entries(map).filter(([tabId]) => live.has(Number(tabId)))
    );

    await store.writeTabMap(map);
    await persistAssociations(map);
    await store.writeSnapshot({ pins, order });
    await clearErrorBadge();
  } catch (e) {
    console.error("magicPin: reconcile failed", e);
    await setErrorBadge();
  }
});

const scheduleReconcile = debounce(reconcile, 500);

// ---------- local -> remote: deletions ----------

const handleLocalPinGone = serialize(async (tabId) => {
  try {
    if (await store.readPaused()) return;
    const tabMap = await store.readTabMap();
    const pinId = tabMap[tabId];
    if (!pinId) return;
    delete tabMap[tabId];
    await store.writeTabMap(tabMap);
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
});

// ---------- local -> remote: order ----------

const pushOrder = serialize(async () => {
  try {
    if (await store.readPaused()) return;
    const tabMap = await store.readTabMap();
    const order = computeLocalOrder(await getLocalPinnedTabs(), tabMap);
    await store.writePins({ order });
    const snapshot = await store.readSnapshot();
    snapshot.order = order;
    await store.writeSnapshot(snapshot);
    await store.writeLastSync(Date.now());
  } catch (e) {
    console.error("magicPin: failed to sync order", e);
    await setErrorBadge();
  }
});

const schedulePushOrder = debounce(pushOrder, 1500);

// ---------- local -> remote: navigation (merge-on-write) ----------

const navigatedPins = new Set();

const flushNav = serialize(async () => {
  const navigatedPinIds = [...navigatedPins];
  navigatedPins.clear();
  try {
    if (await store.readPaused()) return;
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
    // Re-queue so the urls retry on the next flush instead of going stale.
    for (const id of navigatedPinIds) navigatedPins.add(id);
    console.error("magicPin: failed to sync navigation", e);
    await setErrorBadge();
  }
});

const scheduleNavFlush = debounce(flushNav, 10000);

// ---------- event wiring (top level, so events wake the event page) ----------

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (isEcho(tabId) || tab.incognito) return;
    if (changeInfo.pinned === true) scheduleReconcile(); // new local pin -> upload
    if (changeInfo.pinned === false) handleLocalPinGone(tabId);
    if (changeInfo.url && tab.pinned) {
      store
        .readTabMap()
        .then((tabMap) => {
          if (tabMap[tabId]) {
            navigatedPins.add(tabMap[tabId]);
            scheduleNavFlush();
          }
        })
        .catch((e) => console.error("magicPin: nav tracking failed", e));
    }
  },
  { properties: ["pinned", "url"] }
);

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // A closing window (or browser shutdown) is NOT a user unpin.
  if (isEcho(tabId) || removeInfo.isWindowClosing) return;
  handleLocalPinGone(tabId);
});

browser.tabs.onMoved.addListener((tabId) => {
  if (isEcho(tabId)) return;
  store
    .readTabMap()
    .then((tabMap) => {
      if (tabMap[tabId]) schedulePushOrder();
    })
    .catch((e) => console.error("magicPin: move tracking failed", e));
});

// Cross-window drags fire onAttached, not onMoved.
browser.tabs.onAttached.addListener((tabId) => {
  if (isEcho(tabId)) return;
  store
    .readTabMap()
    .then((tabMap) => {
      if (tabMap[tabId]) schedulePushOrder();
    })
    .catch((e) => console.error("magicPin: attach tracking failed", e));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") scheduleReconcile();
});

browser.runtime.onStartup.addListener(() => scheduleReconcile());
browser.runtime.onInstalled.addListener(() => scheduleReconcile());
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== browser.windows.WINDOW_ID_NONE) scheduleReconcile();
});
