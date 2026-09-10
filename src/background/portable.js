// Pure backup import/export. The file format is intentionally simple and
// versioned so backups outlive storage-layer changes: every device set and
// snapshot becomes a named set; importing recreates them as snapshots.

export const FORMAT_VERSION = 1;

// Malformed records (e.g. written by a future schema) are skipped: a backup
// this function produces must always be re-importable.
const exportable = ([, r]) =>
  r && typeof r.name === "string" && r.name.trim() && Array.isArray(r.pins) &&
  r.pins.every((p) => p && typeof p.url === "string" && p.url);

export function buildExport({ devices = {}, snapshots = {} } = {}, exportedAt) {
  const toSet = (kind) => ([, record]) => ({
    kind,
    name: record.name,
    updatedAt: record.updatedAt,
    pins: record.pins,
  });
  return {
    magicPin: FORMAT_VERSION,
    exportedAt,
    sets: [
      ...Object.entries(devices).filter(exportable).map(toSet("device")),
      ...Object.entries(snapshots).filter(exportable).map(toSet("snapshot")),
    ],
  };
}

// Throws a readable Error on anything malformed. Returns [{ name, pins }].
// URLs are kept as-is (pinned about: pages roundtrip); tabs.create is the
// enforcement point for what can actually open.
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  if (data?.magicPin !== FORMAT_VERSION) {
    throw new Error("not a magicPin export (or a newer format)");
  }
  return validateImportSets(data.sets);
}

// Shared with the background handler. Preserve backup data; Firefox enforces
// storage quotas when the complete batch of snapshots is written.
export function validateImportSets(sets) {
  if (!Array.isArray(sets)) throw new Error("missing set list");
  return sets.map((set, i) => {
    if (typeof set?.name !== "string" || !set.name.trim()) {
      throw new Error(`set ${i + 1}: missing name`);
    }
    if (!Array.isArray(set.pins)) {
      throw new Error(`set ${i + 1}: bad pin list`);
    }
    const pins = set.pins.map((p, j) => {
      if (typeof p?.url !== "string" || !p.url) {
        throw new Error(`set ${i + 1}, pin ${j + 1}: bad url`);
      }
      return {
        url: p.url,
        title: typeof p.title === "string" ? p.title : "",
        ...(typeof p.cookieStoreId === "string" && p.cookieStoreId !== "firefox-default"
          ? { cookieStoreId: p.cookieStoreId }
          : {}),
      };
    });
    return { name: set.name, pins };
  });
}
