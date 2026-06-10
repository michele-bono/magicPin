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
  document.getElementById("apply").disabled = Boolean(paused);

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
  document.getElementById("apply").disabled = e.target.checked;
  if (!e.target.checked) {
    // Kick the background so unpausing uploads local changes immediately
    // instead of waiting for the next sync/focus event.
    browser.runtime.sendMessage({ type: "unpause" }).catch(() => {});
  }
});

// Importing is manual: this replaces the pinned tabs on THIS device with the
// synced set (creates missing pins, closes removed ones, matches the order).
document.getElementById("apply").addEventListener("click", () => {
  const button = document.getElementById("apply");
  button.disabled = true;
  button.textContent = "Replacing…";
  browser.runtime
    .sendMessage({ type: "apply" })
    .catch((e) => console.error("magicPin popup:", e))
    .finally(() => {
      button.disabled = false;
      button.textContent = "Replace pinned tabs with synced set";
    });
});

// Re-render while open so incoming syncs and lastSync stay current.
browser.storage.onChanged.addListener(() => {
  render().catch((e) => console.error("magicPin popup:", e));
});

render();
