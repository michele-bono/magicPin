import { pinsEqual } from "./pins.js";

const DEVICE_PREFIX = "device:";
// v3 = per-device pin sets (device:<id> records). v1/v2 used a merged global
// set under pin:<uuid> keys; those are removed by the one-time migration and
// older extension versions are fenced off by the version check.
const SCHEMA_VERSION = 3;

export async function ensureSchema() {
  const { meta } = await browser.storage.sync.get("meta");
  if (meta?.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`magicPin: unsupported schema v${meta.schemaVersion}`);
  }
  if ((meta?.schemaVersion ?? 0) < SCHEMA_VERSION) {
    const all = await browser.storage.sync.get(null);
    const legacy = Object.keys(all).filter((k) => k.startsWith("pin:") || k === "order");
    if (legacy.length) await browser.storage.sync.remove(legacy);
    await browser.storage.sync.set({ meta: { schemaVersion: SCHEMA_VERSION } });
  }
}

// devices: { [deviceId]: { name, updatedAt, pins: [{url, title, cookieStoreId?}] } }
export async function readDevices() {
  const all = await browser.storage.sync.get(null);
  const devices = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(DEVICE_PREFIX)) devices[key.slice(DEVICE_PREFIX.length)] = value;
  }
  return devices;
}

export async function writeDevice(deviceId, record) {
  await browser.storage.sync.set({ [DEVICE_PREFIX + deviceId]: record });
}

export async function removeDevice(deviceId) {
  await browser.storage.sync.remove(DEVICE_PREFIX + deviceId);
}

// This device's stable id and user-editable name (storage.local: per device).
// Reinstalls (and temporary-add-on updates) wipe storage.local; before minting
// a new identity, adopt the UNIQUE synced record whose pin set matches the
// live tabs — same machine, same pins — so the device keeps its name instead
// of leaving a ghost record behind. Ambiguous matches (two devices with
// identical sets) mint a fresh identity rather than risk hijacking another
// device's record.
export async function getDeviceIdentity(currentPins) {
  let { deviceId, deviceName } = await browser.storage.local.get(["deviceId", "deviceName"]);
  if (deviceId) return { deviceId, deviceName };

  if (currentPins?.length) {
    const matches = Object.entries(await readDevices()).filter(([, record]) =>
      pinsEqual(record.pins, currentPins)
    );
    if (matches.length === 1) {
      [deviceId, { name: deviceName }] = matches[0];
      await browser.storage.local.set({ deviceId, deviceName });
      return { deviceId, deviceName };
    }
  }

  deviceId = crypto.randomUUID();
  const platform = await browser.runtime.getPlatformInfo().catch(() => ({ os: "device" }));
  deviceName = `${platform.os} · ${deviceId.slice(0, 4)}`;
  await browser.storage.local.set({ deviceId, deviceName });
  return { deviceId, deviceName };
}

export async function setDeviceName(deviceName) {
  await browser.storage.local.set({ deviceName });
}

export async function readPaused() {
  const { paused } = await browser.storage.local.get("paused");
  return Boolean(paused);
}

export async function writeLastSync(ts) {
  await browser.storage.local.set({ lastSync: ts });
}

// Snapshots: named, user-saved pin sets. Same record shape as devices but
// only ever written explicitly — they're versions you chose to keep.
const SNAPSHOT_PREFIX = "snapshot:";

export async function readSnapshots() {
  const all = await browser.storage.sync.get(null);
  const snapshots = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(SNAPSHOT_PREFIX)) snapshots[key.slice(SNAPSHOT_PREFIX.length)] = value;
  }
  return snapshots;
}

export async function writeSnapshot(snapshotId, record) {
  await browser.storage.sync.set({ [SNAPSHOT_PREFIX + snapshotId]: record });
}

export async function removeSnapshot(snapshotId) {
  await browser.storage.sync.remove(SNAPSHOT_PREFIX + snapshotId);
}

// Undo slot (local, per device): what the pinned tabs looked like just before
// the last replace/merge. Restoring writes the pre-restore state back into the
// slot, so the button toggles between the two states (undo/redo).
export async function readUndo() {
  const { undo } = await browser.storage.local.get("undo");
  return undo;
}

export async function writeUndo(undo) {
  await browser.storage.local.set({ undo });
}
