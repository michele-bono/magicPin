const PIN_PREFIX = "pin:";

export async function readRemote() {
  const all = await browser.storage.sync.get(null);
  const pins = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PIN_PREFIX)) pins[key.slice(PIN_PREFIX.length)] = value;
  }
  return { pins, order: Array.isArray(all.order) ? all.order : [] };
}

// Callers must not pass the same id in both `set` and `remove` (remove wins).
// The set and remove storage calls are intentionally separate (storage.sync has
// no transactions); if interrupted, stale pin keys linger until a later write.
export async function writePins({ set = {}, remove = [], order } = {}) {
  const toSet = {};
  for (const [id, pin] of Object.entries(set)) toSet[PIN_PREFIX + id] = pin;
  if (order) toSet.order = order;
  if (Object.keys(toSet).length) await browser.storage.sync.set(toSet);
  if (remove.length) await browser.storage.sync.remove(remove.map((id) => PIN_PREFIX + id));
}

// v2 = pin records may carry cookieStoreId (container identity).
const SCHEMA_VERSION = 2;

export async function ensureSchema() {
  const { meta } = await browser.storage.sync.get("meta");
  if (!meta) {
    await browser.storage.sync.set({ meta: { schemaVersion: 1 } });
    return;
  }
  if (meta.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`magicPin: unsupported schema v${meta.schemaVersion}`);
  }
}

// Container records are a v2 concept. Stamping v2 fences off devices still
// running the v1 extension (their ensureSchema throws -> error badge, syncing
// stops) so their URL-only dedupe can't destroy container pins. Called lazily,
// only when the first container record is written: container-free users keep
// their old devices syncing.
export async function ensureContainerSchema() {
  const { meta } = await browser.storage.sync.get("meta");
  if ((meta?.schemaVersion ?? 1) < 2) {
    await browser.storage.sync.set({ meta: { schemaVersion: 2 } });
  }
}

export async function readSnapshot() {
  const { snapshot } = await browser.storage.local.get("snapshot");
  return snapshot ?? { pins: {}, order: [] };
}

export async function writeSnapshot(snapshot) {
  await browser.storage.local.set({ snapshot });
}

export async function readTabMap() {
  const { tabMap } = await browser.storage.session.get("tabMap");
  return tabMap ?? {};
}

export async function writeTabMap(tabMap) {
  await browser.storage.session.set({ tabMap });
}

export async function readPaused() {
  const { paused } = await browser.storage.local.get("paused");
  return Boolean(paused);
}

export async function writeLastSync(ts) {
  await browser.storage.local.set({ lastSync: ts });
}
