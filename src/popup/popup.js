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

// Replace closes tabs, so it's armed on first click and runs on the second.
let armedDeviceId = null;
let busy = false;

function deviceRow(deviceId, device, ownId) {
  const isOwn = deviceId === ownId;
  const root = document.createElement("div");
  root.className = "device";

  const head = document.createElement("div");
  head.className = "device-head";

  if (isOwn) {
    const name = document.createElement("input");
    name.className = "device-name";
    name.value = device.name;
    name.title = "Rename this device";
    name.addEventListener("change", () => {
      browser.runtime
        .sendMessage({ type: "rename", name: name.value })
        .catch((e) => console.error("magicPin popup:", e));
    });
    head.append(name);
  } else {
    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = device.name;
    head.append(name);
  }

  const meta = document.createElement("span");
  meta.className = "device-meta";
  meta.textContent = isOwn
    ? `this device · ${device.pins.length}`
    : `${device.pins.length} · ${relativeTime(device.updatedAt)}`;
  head.append(meta);

  if (!isOwn) {
    const replace = document.createElement("button");
    const armed = armedDeviceId === deviceId;
    replace.textContent = armed ? "Sure? This closes tabs" : "Replace";
    replace.className = armed ? "armed" : "";
    replace.disabled = busy;
    replace.addEventListener("click", async () => {
      if (armedDeviceId !== deviceId) {
        armedDeviceId = deviceId;
        render();
        return;
      }
      armedDeviceId = null;
      busy = true;
      render();
      try {
        await browser.runtime.sendMessage({ type: "replace", deviceId });
      } catch (e) {
        console.error("magicPin popup:", e);
      } finally {
        busy = false;
        render();
      }
    });
    head.append(replace);

    const forget = document.createElement("button");
    forget.className = "forget";
    forget.textContent = "✕";
    forget.title = "Forget this device's saved pins";
    forget.addEventListener("click", () => {
      browser.runtime
        .sendMessage({ type: "forget", deviceId })
        .catch((e) => console.error("magicPin popup:", e));
    });
    head.append(forget);
  }

  root.append(head);

  const ul = document.createElement("ul");
  for (const pin of device.pins) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = pin.title || pin.url;
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = pin.cookieStoreId ? `${safeHost(pin.url)} ▣` : safeHost(pin.url);
    if (pin.cookieStoreId) host.title = `Container: ${pin.cookieStoreId}`;
    li.append(title, host);
    ul.append(li);
  }
  root.append(ul);
  return root;
}

async function render() {
  const all = await browser.storage.sync.get(null);
  const { paused, lastSync, deviceId: ownId } = await browser.storage.local.get([
    "paused",
    "lastSync",
    "deviceId",
  ]);

  document.getElementById("pause").checked = Boolean(paused);
  document.getElementById("sync").disabled = busy || Boolean(paused);

  const devices = Object.keys(all)
    .filter((k) => k.startsWith("device:"))
    .map((k) => [k.slice(7), all[k]])
    // Own device first, then most recently saved.
    .sort(([idA, a], [idB, b]) =>
      idA === ownId ? -1 : idB === ownId ? 1 : (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    );

  const container = document.getElementById("devices");
  container.textContent = "";
  for (const [deviceId, device] of devices) {
    container.append(deviceRow(deviceId, device, ownId));
  }
  if (!devices.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No saved devices yet — pin a tab to save this device's set";
    container.append(div);
  }

  document.getElementById("status").textContent = lastSync
    ? `Last save: ${new Date(lastSync).toLocaleString()}`
    : "Nothing saved yet";
}

document.getElementById("pause").addEventListener("change", async (e) => {
  await browser.storage.local.set({ paused: e.target.checked });
  if (!e.target.checked) {
    // Save current state immediately on unpause.
    browser.runtime.sendMessage({ type: "unpause" }).catch(() => {});
  }
  render().catch((e2) => console.error("magicPin popup:", e2));
});

document.getElementById("sync").addEventListener("click", async () => {
  const button = document.getElementById("sync");
  busy = true;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await browser.runtime.sendMessage({ type: "sync" });
  } catch (e) {
    console.error("magicPin popup:", e);
  } finally {
    busy = false;
    button.textContent = "Sync now";
    render().catch(() => {});
  }
});

// Re-render while open so incoming syncs stay current.
browser.storage.onChanged.addListener(() => {
  render().catch((e) => console.error("magicPin popup:", e));
});

render();
