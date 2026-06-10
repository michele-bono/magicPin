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

export async function ensureSchema() {
  const { meta } = await browser.storage.sync.get("meta");
  if (!meta) {
    await browser.storage.sync.set({ meta: { schemaVersion: 1 } });
    return;
  }
  if (meta.schemaVersion > 1) {
    throw new Error(`magicPin: unsupported schema v${meta.schemaVersion}`);
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
