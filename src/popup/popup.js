function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function render() {
  const all = await browser.storage.sync.get(null);
  const { paused, lastSync } = await browser.storage.local.get(["paused", "lastSync"]);

  document.getElementById("pause").checked = Boolean(paused);

  const order = Array.isArray(all.order) ? all.order : [];
  const pins = Object.keys(all)
    .filter((k) => k.startsWith("pin:"))
    .map((k) => [k.slice(4), all[k]])
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  const ul = document.getElementById("pins");
  ul.textContent = "";
  for (const [, pin] of pins) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = pin.title || pin.url;
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = safeHost(pin.url);
    li.append(title, host);
    ul.append(li);
  }
  if (!pins.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No pinned tabs synced yet";
    ul.append(li);
  }

  document.getElementById("status").textContent = lastSync
    ? `Last sync write: ${new Date(lastSync).toLocaleString()}`
    : "No sync writes yet";
}

document.getElementById("pause").addEventListener("change", async (e) => {
  await browser.storage.local.set({ paused: e.target.checked });
  if (!e.target.checked) {
    // Kick the background so unpausing catches up immediately instead of
    // waiting for the next sync/focus event.
    browser.runtime.sendMessage({ type: "unpause" }).catch(() => {});
  }
});

// Re-render while open so incoming syncs and lastSync stay current.
browser.storage.onChanged.addListener(() => {
  render().catch((e) => console.error("magicPin popup:", e));
});

render();
