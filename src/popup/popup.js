import { planReplace } from "../background/pins.js";
import { parseImport } from "../background/portable.js";

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function relativeTime(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function send(msg) {
  return browser.runtime.sendMessage(msg);
}

function logError(e) {
  console.error("magicPin popup:", e);
}

async function localPinnedTabs() {
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

// Replace closes tabs, so it's armed on first click and runs on the second,
// previewing its consequences ("Sure? +3 −2") while armed.
let armedKey = null;
let armedPreview = "";
// Parse errors never reach the background, so they'd be wiped by the next
// storage-driven re-render; keep them popup-local and prefer them in render.
let parseError = null;
let busy = false;
// Expanded/collapsed choices survive the frequent storage-driven re-renders.
const openState = new Map();

async function runAction(msg) {
  armedKey = null; // any action settles a pending Replace confirmation
  parseError = null;
  busy = true;
  render().catch(logError);
  try {
    await send(msg);
  } catch (e) {
    logError(e);
  } finally {
    busy = false;
    render().catch(logError);
  }
}

// Buttons inside <summary> must not toggle the <details>.
function summaryButton(label, title, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  if (title) button.title = title;
  button.disabled = busy;
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return button;
}

function pinList(pins) {
  const ul = document.createElement("ul");
  for (const pin of pins) {
    const li = document.createElement("li");

    const add = document.createElement("button");
    add.className = "addpin";
    add.textContent = "+";
    add.title = "Pin this here";
    add.disabled = busy;
    add.addEventListener("click", () => runAction({ type: "addPin", pin }));

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = pin.title || pin.url;
    title.title = pin.url;

    const host = document.createElement("span");
    host.className = "host";
    host.textContent = pin.cookieStoreId ? `${safeHost(pin.url)} ▣` : safeHost(pin.url);
    if (pin.cookieStoreId) host.title = `Container: ${pin.cookieStoreId}`;

    li.append(add, title, host);
    ul.append(li);
  }
  if (!pins.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "no pins";
    ul.append(li);
  }
  return ul;
}

// One collapsible row for a device or snapshot.
function sourceSection({ key, record, isOwn, open }) {
  const details = document.createElement("details");
  details.className = "source";
  details.open = openState.has(key) ? openState.get(key) : open;
  details.addEventListener("toggle", () => openState.set(key, details.open));

  const summary = document.createElement("summary");

  if (isOwn) {
    const name = document.createElement("input");
    name.className = "source-name";
    name.value = record.name;
    name.title = "Rename this device";
    name.addEventListener("click", (e) => e.preventDefault());
    name.addEventListener("change", () =>
      send({ type: "rename", name: name.value }).catch(logError)
    );
    summary.append(name);
  } else {
    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = record.name;
    summary.append(name);
  }

  const meta = document.createElement("span");
  meta.className = "source-meta";
  meta.textContent = isOwn
    ? `this device · ${record.pins.length}`
    : `${record.pins.length} · ${relativeTime(record.updatedAt)}`;
  summary.append(meta);

  if (!isOwn) {
    const armed = armedKey === key;
    const replace = summaryButton(
      armed ? `Sure?${armedPreview || " Closes tabs"}` : "Replace",
      "Make this device's pinned tabs match this set (two clicks)",
      async () => {
        if (armedKey !== key) {
          armedKey = key;
          armedPreview = "";
          try {
            const plan = planReplace(await localPinnedTabs(), record.pins);
            const adds = plan.sequence.filter((s) => s.create).length;
            armedPreview = ` +${adds} −${plan.close.length}`;
          } catch (e) {
            logError(e);
          }
          render().catch(logError);
          return;
        }
        armedKey = null;
        runAction({ type: "replace", key });
      }
    );
    if (armed) replace.className = "armed";
    summary.append(replace);

    summary.append(
      summaryButton("Merge", "Add this set's missing pins here, close nothing", () =>
        runAction({ type: "merge", key })
      )
    );

    const isSnapshot = key.startsWith("snapshot:");
    const remove = summaryButton(
      "✕",
      isSnapshot ? "Delete this snapshot" : "Forget this device's saved pins",
      () => {
        armedKey = null;
        send(
          isSnapshot
            ? { type: "deleteSnapshot", id: key.slice(9) }
            : { type: "forget", deviceId: key.slice(7) }
        ).catch(logError);
      }
    );
    remove.classList.add("remove");
    summary.append(remove);
  }

  details.append(summary, pinList(record.pins));
  return details;
}

function groupHeading(text) {
  const h2 = document.createElement("h2");
  h2.textContent = text;
  return h2;
}

const validRecord = (d) =>
  d &&
  typeof d.name === "string" &&
  Array.isArray(d.pins) &&
  d.pins.every((p) => p && typeof p.url === "string");

async function render() {
  // Don't rebuild the DOM out from under an in-progress device rename.
  if (document.activeElement?.classList?.contains("source-name")) return;
  const all = await browser.storage.sync.get(null);
  const { paused, lastSync, deviceId: ownId, undo, lastError } = await browser.storage.local.get(
    ["paused", "lastSync", "deviceId", "undo", "lastError"]
  );

  document.getElementById("pause").checked = Boolean(paused);
  document.getElementById("sync").disabled = busy || Boolean(paused);
  document.getElementById("snapsave").disabled = busy;

  const undoButton = document.getElementById("undo");
  undoButton.hidden = !undo;
  if (undo) {
    undoButton.textContent = `Undo last replace (${relativeTime(undo.savedAt)})`;
    undoButton.disabled = busy;
  }

  const byPrefix = (prefix) =>
    Object.keys(all)
      .filter((k) => k.startsWith(prefix))
      .map((k) => [k, all[k]])
      // Tolerate malformed or future-schema records instead of blanking the UI.
      .filter(([, d]) => validRecord(d));

  const devices = byPrefix("device:").sort(([keyA, a], [keyB, b]) =>
    keyA === `device:${ownId}`
      ? -1
      : keyB === `device:${ownId}`
        ? 1
        : (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  );
  const snapshots = byPrefix("snapshot:").sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const container = document.getElementById("sources");
  container.textContent = "";

  for (const [key, record] of devices) {
    const isOwn = key === `device:${ownId}`;
    container.append(sourceSection({ key, record, isOwn, open: isOwn }));
  }
  if (!devices.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No saved devices yet — pin a tab to save this device's set";
    container.append(div);
  }

  if (snapshots.length) {
    container.append(groupHeading("Snapshots"));
    for (const [key, record] of snapshots) {
      container.append(sourceSection({ key, record, isOwn: false, open: false }));
    }
  }

  document.getElementById("status").textContent = lastSync
    ? `Last save: ${new Date(lastSync).toLocaleString()}`
    : "Nothing saved yet";

  const errorLine = document.getElementById("error");
  if (parseError) {
    errorLine.hidden = false;
    errorLine.textContent = `⚠ ${parseError}`;
  } else {
    errorLine.hidden = !lastError;
    if (lastError) {
      errorLine.textContent = `⚠ ${lastError.message} (${relativeTime(lastError.at)})`;
    }
  }

  renderQuota(all).catch(logError);
}

async function renderQuota(all) {
  let bytes;
  try {
    bytes = await browser.storage.sync.getBytesInUse(null);
  } catch {
    bytes = new TextEncoder().encode(JSON.stringify(all)).length; // estimate
  }
  const quotaKb = (browser.storage.sync.QUOTA_BYTES ?? 102400) / 1024;
  document.getElementById("quota").textContent =
    `Sync storage: ${(bytes / 1024).toFixed(1)} / ${Math.round(quotaKb)} KB`;
}

document.getElementById("pause").addEventListener("change", async (e) => {
  await browser.storage.local.set({ paused: e.target.checked });
  if (!e.target.checked) {
    // Save current state immediately on unpause.
    send({ type: "unpause" }).catch(() => {});
  }
  render().catch(logError);
});

document.getElementById("sync").addEventListener("click", async () => {
  const button = document.getElementById("sync");
  button.textContent = "Saving…";
  await runAction({ type: "sync" });
  button.textContent = "Sync now";
});

document.getElementById("snapsave").addEventListener("click", async () => {
  const input = document.getElementById("snapname");
  await runAction({ type: "snapshot", name: input.value });
  input.value = "";
});

document.getElementById("undo").addEventListener("click", () => runAction({ type: "undo" }));

// The background owns the download: a blob URL minted here would die with
// the popup document and could kill the download mid-flight.
document.getElementById("export").addEventListener("click", () => {
  send({ type: "export" }).catch(logError);
});

document.getElementById("import").addEventListener("click", () => {
  document.getElementById("importfile").click();
});

document.getElementById("importfile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  parseError = null;
  try {
    const sets = parseImport(await file.text());
    await runAction({ type: "import", sets });
  } catch (err) {
    parseError = `Import failed: ${err.message}`;
    render().catch(logError);
  }
});

// Clicking anywhere that isn't a button disarms a pending Replace. (Button
// clicks manage the armed state themselves; this handler runs after them in
// the bubble phase, by which point render() has already swapped the row DOM.)
document.addEventListener("click", (e) => {
  if (armedKey !== null && !e.target.closest("button")) {
    armedKey = null;
    render().catch(() => {});
  }
});

// Re-render while open so incoming syncs stay current.
browser.storage.onChanged.addListener(() => {
  render().catch(logError);
});

render();
