// Pure backup import/export. The file format is intentionally simple and
// versioned so backups outlive storage-layer changes: every device set and
// snapshot becomes a named set; importing recreates them as snapshots.

export const FORMAT_VERSION = 1;

const MAX_SETS = 20;
const MAX_PINS = 200;
const MAX_NAME = 40;
const MAX_URL = 2000;
const MAX_TITLE = 300;

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
      ...Object.entries(devices).map(toSet("device")),
      ...Object.entries(snapshots).map(toSet("snapshot")),
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
  if (!Array.isArray(data.sets) || !data.sets.length) throw new Error("no sets in file");
  if (data.sets.length > MAX_SETS) throw new Error(`too many sets (max ${MAX_SETS})`);

  return data.sets.map((set, i) => {
    if (typeof set?.name !== "string" || !set.name.trim()) {
      throw new Error(`set ${i + 1}: missing name`);
    }
    if (!Array.isArray(set.pins) || set.pins.length > MAX_PINS) {
      throw new Error(`set "${set.name.slice(0, MAX_NAME)}": bad pin list`);
    }
    const pins = set.pins.map((p, j) => {
      if (typeof p?.url !== "string" || !p.url || p.url.length > MAX_URL) {
        throw new Error(`set "${set.name.slice(0, MAX_NAME)}", pin ${j + 1}: bad url`);
      }
      return {
        url: p.url,
        title: typeof p.title === "string" ? p.title.slice(0, MAX_TITLE) : "",
        ...(typeof p.cookieStoreId === "string" && p.cookieStoreId !== "firefox-default"
          ? { cookieStoreId: p.cookieStoreId }
          : {}),
      };
    });
    return { name: set.name.trim().slice(0, MAX_NAME), pins };
  });
}
