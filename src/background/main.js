import { serializePins, pinsEqual, planReplace, planMerge } from "./pins.js";
import { buildExport } from "./portable.js";
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

// Errors surface in two places: the toolbar badge (popup closed) and a
// storage.local record the popup footer renders (badge is invisible while
// the popup covers it).
async function reportError(message) {
  await browser.storage.local.set({ lastError: { message, at: Date.now() } });
  await setErrorBadge();
}

async function clearError() {
  await browser.storage.local.remove("lastError");
  await clearErrorBadge();
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

async function exportNow({ force = false } = {}) {
  try {
    if (!force && (await store.readPaused())) return;
    await store.ensureSchema();
    const { deviceId, deviceName } = await store.getDeviceIdentity();
    const pins = serializePins(await getLocalPinnedTabs());
    const current = (await store.readDevices())[deviceId];
    // Identity-sequence comparison: title-only churn doesn't burn sync quota.
    if (current && current.name === deviceName && pinsEqual(current.pins, pins)) return;
    await store.writeDevice(deviceId, { name: deviceName, updatedAt: Date.now(), pins });
    await store.writeLastSync(Date.now());
    await clearError();
  } catch (e) {
    console.error("magicPin: export failed", e);
    await reportError(`Saving failed: ${e.message}`);
  }
}

const exportPins = serialize(exportNow);
const scheduleExport = debounce(exportPins, 2000);
// Navigation inside pinned app tabs is frequent; give it a longer window.
const scheduleNavExport = debounce(exportPins, 10000);

// ---------- replace / merge: adopt pins from a device, snapshot, or undo ----------

// key: "device:<id>" | "snapshot:<id>" | "undo"
async function resolvePins(key) {
  if (key === "undo") return (await store.readUndo())?.pins;
  if (key?.startsWith("device:")) return (await store.readDevices())[key.slice(7)]?.pins;
  if (key?.startsWith("snapshot:")) return (await store.readSnapshots())[key.slice(9)]?.pins;
  return undefined;
}

// Shared by replace and merge. The pre-mutation state goes into the undo slot
// only AFTER the apply succeeds — if the apply throws, the slot keeps its old
// content, so a failed undo can be retried instead of destroying its target.
// Since resolvePins("undo") reads before the slot is rewritten, the undo
// action itself toggles between the two states (undo/redo).
async function adoptPins(key, makePlan) {
  try {
    await store.ensureSchema();
    const target = await resolvePins(key);
    if (!target) throw new Error(`unknown source ${key}`);
    const current = await getLocalPinnedTabs();
    const before = serializePins(current);
    const failed = await applyReplace(makePlan(current, target));
    await store.writeUndo({ pins: before, savedAt: Date.now() });
    if (failed) {
      await reportError(
        `${failed} pin(s) couldn't be opened here (privileged URL or missing container)`
      );
    } else {
      await clearError();
    }
  } catch (e) {
    console.error("magicPin: adopt failed", e);
    await reportError(`Couldn't apply that set: ${e.message}`);
  }
  // The result is now this device's current set; save it right away. Forced:
  // this is an explicit user action, so the record must mirror the result
  // even while auto-saving is paused.
  await exportNow({ force: true });
}

const replaceWith = serialize((key) => adoptPins(key, planReplace));
const mergeWith = serialize((key) => adoptPins(key, planMerge));

// Pin one record here (no-op when an identical pin already exists). Doesn't
// touch the undo slot — a single added pin is trivial to remove by hand.
const addPin = serialize(async (pin) => {
  try {
    if (!pin?.url) return;
    const failed = await applyReplace(planMerge(await getLocalPinnedTabs(), [pin]));
    if (failed) {
      await reportError("That pin couldn't be opened here (privileged URL or missing container)");
    } else {
      await clearError();
    }
  } catch (e) {
    console.error("magicPin: add pin failed", e);
    await reportError(`Couldn't pin that: ${e.message}`);
  }
  await exportNow({ force: true });
});

// ---------- snapshots ----------

const saveSnapshot = serialize(async (name) => {
  try {
    await store.ensureSchema();
    const pins = serializePins(await getLocalPinnedTabs());
    const trimmed =
      String(name ?? "")
        .trim()
        .slice(0, 40) || `Snapshot ${new Date().toLocaleDateString()}`;
    await store.writeSnapshot(crypto.randomUUID(), {
      name: trimmed,
      updatedAt: Date.now(),
      pins,
    });
    await store.writeLastSync(Date.now());
    await clearError();
  } catch (e) {
    console.error("magicPin: snapshot failed", e);
    await reportError(`Snapshot failed: ${e.message}`);
  }
});

const deleteSnapshot = serialize(async (snapshotId) => {
  try {
    await store.removeSnapshot(snapshotId);
    await clearError();
  } catch (e) {
    console.error("magicPin: delete snapshot failed", e);
    await reportError(`Delete failed: ${e.message}`);
  }
});

// ---------- device management ----------

const renameDevice = serialize(async (name) => {
  try {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) return;
    await store.setDeviceName(trimmed);
    await exportNow({ force: true });
  } catch (e) {
    console.error("magicPin: rename failed", e);
    await reportError(`Rename failed: ${e.message}`);
  }
});

const forgetDevice = serialize(async (deviceId) => {
  try {
    const { deviceId: own } = await store.getDeviceIdentity();
    if (deviceId === own) return; // own record is recreated by export anyway
    await store.removeDevice(deviceId);
    await clearError();
  } catch (e) {
    console.error("magicPin: forget failed", e);
    await reportError(`Forget failed: ${e.message}`);
  }
});

// ---------- backup import ----------
// Sets arrive pre-validated by the popup's parseImport; re-check the shape
// anyway and recreate everything as snapshots (non-destructive).

const importSets = serialize(async (sets) => {
  try {
    await store.ensureSchema();
    if (!Array.isArray(sets) || !sets.length || sets.length > 20) {
      throw new Error("bad import payload");
    }
    const now = Date.now();
    for (const set of sets) {
      if (typeof set?.name !== "string" || !Array.isArray(set.pins)) {
        throw new Error("bad import payload");
      }
      const pins = set.pins
        .filter((p) => p && typeof p.url === "string" && p.url)
        .slice(0, 200)
        .map((p) => ({
          url: p.url.slice(0, 2000),
          title: typeof p.title === "string" ? p.title.slice(0, 300) : "",
          ...(typeof p.cookieStoreId === "string" && p.cookieStoreId !== "firefox-default"
            ? { cookieStoreId: p.cookieStoreId }
            : {}),
        }));
      await store.writeSnapshot(crypto.randomUUID(), {
        name: set.name.trim().slice(0, 40),
        updatedAt: now,
        pins,
      });
    }
    await store.writeLastSync(now);
    await clearError();
  } catch (e) {
    console.error("magicPin: import failed", e);
    await reportError(`Import failed: ${e.message}`);
  }
});

// ---------- backup export ----------
// Runs here, not in the popup: a blob URL minted by the popup dies with the
// popup document, which can kill the download mid-flight.

const exportBackup = serialize(async () => {
  try {
    const data = buildExport(
      { devices: await store.readDevices(), snapshots: await store.readSnapshots() },
      Date.now()
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    );
    const filename = `magicpin-backup-${new Date().toISOString().slice(0, 10)}.json`;
    await browser.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    await clearError();
  } catch (e) {
    // Cancelling the save dialog rejects too; don't treat that as an error.
    if (!/canceled/i.test(String(e?.message))) {
      console.error("magicPin: export failed", e);
      await reportError(`Export failed: ${e.message}`);
    }
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
  if (msg?.type === "replace") return replaceWith(msg.key);
  if (msg?.type === "merge") return mergeWith(msg.key);
  if (msg?.type === "undo") return replaceWith("undo");
  if (msg?.type === "addPin") return addPin(msg.pin);
  if (msg?.type === "snapshot") return saveSnapshot(msg.name);
  if (msg?.type === "import") return importSets(msg.sets);
  if (msg?.type === "export") return exportBackup();
  if (msg?.type === "deleteSnapshot") return deleteSnapshot(msg.id);
  if (msg?.type === "rename") return renameDevice(msg.name);
  if (msg?.type === "forget") return forgetDevice(msg.deviceId);
});

browser.runtime.onStartup.addListener(() => scheduleExport());
browser.runtime.onInstalled.addListener(() => scheduleExport());
