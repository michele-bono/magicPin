import { serializePins, pinsEqual, planReplace } from "./pins.js";
import { applyReplace, isEcho } from "./tabsync.js";
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
      cookieStoreId: t.cookieStoreId,
    }));
}

async function setErrorBadge() {
  await browser.action.setBadgeText({ text: "!" });
  await browser.action.setBadgeBackgroundColor({ color: "#d7263d" });
}

async function clearErrorBadge() {
  await browser.action.setBadgeText({ text: "" });
}

// All storage-mutating work runs on one promise chain, so the export and
// replace paths never interleave.
let chain = Promise.resolve();
function serialize(fn) {
  return (...args) => {
    const run = chain.then(() => fn(...args));
    chain = run.catch(() => {});
    return run;
  };
}

// ---------- export: save THIS device's pinned tabs to its own record ----------
// One writer per device record means no cross-device merging, ever. Nothing
// in this extension mutates tabs except the explicit replace below.

async function exportNow() {
  try {
    if (await store.readPaused()) return;
    await store.ensureSchema();
    const { deviceId, deviceName } = await store.getDeviceIdentity();
    const pins = serializePins(await getLocalPinnedTabs());
    const current = (await store.readDevices())[deviceId];
    // Identity-sequence comparison: title-only churn doesn't burn sync quota.
    if (current && current.name === deviceName && pinsEqual(current.pins, pins)) return;
    await store.writeDevice(deviceId, { name: deviceName, updatedAt: Date.now(), pins });
    await store.writeLastSync(Date.now());
    await clearErrorBadge();
  } catch (e) {
    console.error("magicPin: export failed", e);
    await setErrorBadge();
  }
}

const exportPins = serialize(exportNow);
const scheduleExport = debounce(exportPins, 2000);
// Navigation inside pinned app tabs is frequent; give it a longer window.
const scheduleNavExport = debounce(exportPins, 10000);

// ---------- replace: make local pinned tabs match a chosen device's set ----------

const replaceWith = serialize(async (sourceDeviceId) => {
  try {
    await store.ensureSchema();
    const source = (await store.readDevices())[sourceDeviceId];
    if (!source) throw new Error(`unknown device ${sourceDeviceId}`);
    const plan = planReplace(await getLocalPinnedTabs(), source.pins);
    await applyReplace(plan);
    await clearErrorBadge();
  } catch (e) {
    console.error("magicPin: replace failed", e);
    await setErrorBadge();
  }
  // The adopted set is now this device's current set; save it right away.
  await exportNow();
});

// ---------- device management ----------

const renameDevice = serialize(async (name) => {
  try {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) return;
    await store.setDeviceName(trimmed);
    await exportNow();
  } catch (e) {
    console.error("magicPin: rename failed", e);
    await setErrorBadge();
  }
});

const forgetDevice = serialize(async (deviceId) => {
  try {
    const { deviceId: own } = await store.getDeviceIdentity();
    if (deviceId === own) return; // own record is recreated by export anyway
    await store.removeDevice(deviceId);
  } catch (e) {
    console.error("magicPin: forget failed", e);
    await setErrorBadge();
  }
});

// ---------- event wiring (top level, so events wake the event page) ----------

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (isEcho(tabId) || tab.incognito) return;
    if (changeInfo.pinned !== undefined) scheduleExport();
    else if (changeInfo.url && tab.pinned) scheduleNavExport();
  },
  { properties: ["pinned", "url"] }
);

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // A closing window (or browser shutdown) is NOT an edit to the pin set.
  if (isEcho(tabId) || removeInfo.isWindowClosing) return;
  scheduleExport(); // no-ops via pinsEqual if the tab wasn't pinned
});

browser.tabs.onMoved.addListener((tabId) => {
  if (isEcho(tabId)) return;
  scheduleExport();
});

// Cross-window drags fire onAttached, not onMoved.
browser.tabs.onAttached.addListener((tabId) => {
  if (isEcho(tabId)) return;
  scheduleExport();
});

browser.runtime.onMessage.addListener((msg) => {
  // Returning the promise makes the popup's sendMessage resolve on completion.
  if (msg?.type === "sync" || msg?.type === "unpause") return exportPins();
  if (msg?.type === "replace") return replaceWith(msg.deviceId);
  if (msg?.type === "rename") return renameDevice(msg.name);
  if (msg?.type === "forget") return forgetDevice(msg.deviceId);
});

browser.runtime.onStartup.addListener(() => scheduleExport());
browser.runtime.onInstalled.addListener(() => scheduleExport());
