import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeTabBrowser } from "./helpers/fake-tabs.js";
import { buildExport, parseImport } from "../src/background/portable.js";

const pin = (url) => ({ url, title: url });
const oldPin = pin("https://old.test/");
const newPin = pin("https://new.test/");
let env;
const local = () => browser.storage.local._data;
const saved = () => browser.storage.sync._data["device:local"].pins;
const send = (message) => browser.runtime.sendMessage(message);
const replace = () => send({ type: "replace", key: "snapshot:target" });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  env = fakeTabBrowser([{ ...oldPin, id: 1, pinned: true, index: 0, windowId: 1, incognito: false }]);
  globalThis.browser = env.browser;
  await browser.storage.local.set({ deviceId: "local", deviceName: "Local" });
  await browser.storage.sync.set({
    meta: { schemaVersion: 3 },
    "device:local": { name: "Local", pins: [oldPin], updatedAt: 1 },
    "snapshot:target": { name: "Target", pins: [newPin], updatedAt: 1 },
  });
  await import("../src/background/main.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable restore recovery", () => {
  it("persists recovery before changing tabs and supports undo/redo", async () => {
    const create = browser.tabs.create.getMockImplementation();
    browser.tabs.create.mockImplementation(async (...args) => {
      expect(local().recovery.pins).toEqual([oldPin]);
      return create(...args);
    });
    await replace();
    expect(saved()).toEqual([newPin]);
    expect(local().undo.pins).toEqual([oldPin]);
    expect(local().recovery).toBeNull();
    browser.tabs.create.mockImplementation(create);
    await send({ type: "undo" });
    expect(saved()).toEqual([oldPin]);
    await send({ type: "undo" });
    expect(saved()).toEqual([newPin]);
  });

  it("keeps recovery and the prior undo after a post-mutation query failure", async () => {
    const previousUndo = { pins: [pin("https://previous.test/")], savedAt: 1 };
    await browser.storage.local.set({ undo: previousUndo });
    browser.tabs.query.mockResolvedValueOnce(structuredClone(env.tabs))
      .mockRejectedValueOnce(new Error("Reorder query failed"));
    await replace();
    expect(env.tabs.map((tab) => tab.url)).toEqual([newPin.url]);
    expect(local().recovery.pins).toEqual([oldPin]);
    expect(local().undo).toEqual(previousUndo);
    expect(local().lastError.message).toContain("Reorder query failed");
    // Reload the event page: the checkpoint must survive its globals.
    vi.clearAllTimers();
    vi.resetModules();
    env.resetListeners();
    await import("../src/background/main.js");
    await send({ type: "undo" });
    expect(saved()).toEqual([oldPin]);
    expect(local().recovery).toBeNull();
  });

  it("does not mutate tabs when the recovery checkpoint cannot be saved", async () => {
    const set = browser.storage.local.set;
    vi.spyOn(browser.storage.local, "set").mockImplementation(async (values) => {
      if (values.recovery) throw new Error("Disk full");
      return set(values);
    });
    await replace();
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
    expect(saved()).toEqual([oldPin]);
    expect(local().lastError.message).toContain("Disk full");
  });

  it("keeps the original recovery target if recovery itself fails", async () => {
    const checkpoint = { pins: [oldPin], savedAt: 1 };
    await browser.storage.local.set({ recovery: checkpoint });
    env.loseTabs();
    browser.tabs.create.mockRejectedValue(new Error("Cannot create tabs"));
    await send({ type: "undo" });
    expect(local().recovery).toEqual(checkpoint);
    expect(saved()).toEqual([oldPin]);
  });
});

describe("error visibility", () => {
  it("retains partial restore errors through forced and automatic saves", async () => {
    browser.storage.sync._data["snapshot:target"].pins.push(pin("about:config"));
    await replace();
    expect(saved()).toEqual([newPin]);
    expect(local().lastError.message).toContain("1 pin(s)");
    await vi.advanceTimersByTimeAsync(10000);
    expect(local().lastError.message).toContain("1 pin(s)");
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
    expect(local().recovery.pins).toEqual([oldPin]);
  });

  it("retains action errors when a save also fails and later succeeds", async () => {
    const set = vi.spyOn(browser.storage.sync, "set").mockRejectedValueOnce(new Error("Quota exceeded"));
    browser.storage.sync._data["snapshot:target"].pins.push(pin("about:config"));
    await replace();
    expect(local().lastError.message).toContain("1 pin(s)");
    expect(local().lastSaveError.message).toContain("Quota exceeded");
    set.mockRestore();
    await send({ type: "sync" });
    expect(local().lastSaveError).toBeUndefined();
    expect(local().lastError.message).toContain("1 pin(s)");
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
  });
});

describe("tab events after restore", () => {
  it("saves an immediate user unpin after creation", async () => {
    browser.storage.sync._data["snapshot:target"].pins.push(pin("https://keep.test/"));
    await replace();
    const changed = env.tabs.find((tab) => tab.url === newPin.url);
    changed.pinned = false;
    browser.tabs.onUpdated.emit(changed.id, { pinned: false }, changed);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saved()).toEqual([pin("https://keep.test/")]);
  });

  it("saves navigation immediately following a restore", async () => {
    await replace();
    const changed = env.tabs[0];
    changed.url = "https://redirected.test/";
    browser.tabs.onUpdated.emit(changed.id, { url: changed.url }, changed);
    await vi.advanceTimersByTimeAsync(10000);
    expect(saved()[0].url).toBe(changed.url);
  });

  it("does not write duplicate sync records for its own tab events", async () => {
    const set = vi.spyOn(browser.storage.sync, "set");
    await replace();
    await vi.advanceTimersByTimeAsync(10000);
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe("missing Firefox pins", () => {
  it.each(["onStartup", "onInstalled"])("preserves saved pins after %s sees an empty session", async (event) => {
    env.loseTabs();
    browser.runtime[event].emit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(saved()).toEqual([oldPin]);
    expect(local().emptyPinsPreserved).toBe(true);
    await send({ type: "replace", key: "device:local" });
    expect(env.tabs.map((tab) => tab.url)).toEqual([oldPin.url]);
    expect(local().emptyPinsPreserved).toBeUndefined();
  });

  it("preserves pins after tab loss, unpause, and rename", async () => {
    env.loseTabs();
    browser.tabs.onRemoved.emit(1, { isWindowClosing: false });
    await vi.advanceTimersByTimeAsync(2000);
    await send({ type: "unpause" });
    await send({ type: "rename", name: "Renamed" });
    expect(saved()).toEqual([oldPin]);
    expect(browser.storage.sync._data["device:local"].name).toBe("Renamed");
    expect(local().emptyPinsPreserved).toBe(true);
  });

  it("allows explicit Sync now to save an intentionally empty set", async () => {
    env.loseTabs();
    await send({ type: "unpause" });
    await send({ type: "sync" });
    expect(saved()).toEqual([]);
    expect(local().emptyPinsPreserved).toBeUndefined();
  });

  it("allows an explicit empty replacement and undo restores the pins", async () => {
    browser.storage.sync._data["snapshot:target"].pins = [];
    await replace();
    expect(saved()).toEqual([]);
    await send({ type: "undo" });
    expect(saved()).toEqual([oldPin]);
  });

  it("does not erase the saved set when restoring it fails", async () => {
    env.loseTabs();
    browser.tabs.create.mockRejectedValue(new Error("Cannot create tabs"));
    await send({ type: "replace", key: "device:local" });
    expect(saved()).toEqual([oldPin]);
    expect(local().lastError).toBeDefined();
  });

  it("keeps the saved pins when recovering from a restore that found no live tabs", async () => {
    env.loseTabs();
    browser.tabs.create.mockRejectedValue(new Error("Cannot create tabs"));
    await send({ type: "replace", key: "device:local" });
    expect(local().recovery.pins).toEqual([]);
    browser.tabs.create.mockImplementation(async () => { throw new Error("still failing"); });
    await send({ type: "undo" });
    expect(saved()).toEqual([oldPin]);
  });

  it("never erases the saved pins when merging an empty set", async () => {
    env.loseTabs();
    browser.storage.sync._data["snapshot:target"].pins = [];
    await send({ type: "merge", key: "snapshot:target" });
    expect(saved()).toEqual([oldPin]);
  });

  it("keeps the undo target after a failed undo so it can be retried", async () => {
    const create = browser.tabs.create.getMockImplementation();
    await replace();
    expect(local().undo.pins).toEqual([oldPin]);
    browser.tabs.create.mockRejectedValue(new Error("Cannot create tabs"));
    await send({ type: "undo" });
    expect(local().lastError).toBeDefined();
    browser.tabs.create.mockImplementation(create);
    await send({ type: "undo" });
    expect(saved()).toEqual([oldPin]);
  });

  it("keeps the oldest pending recovery checkpoint across a second failed action", async () => {
    browser.tabs.create.mockRejectedValue(new Error("Cannot create tabs"));
    await replace();
    expect(local().recovery.pins).toEqual([oldPin]);
    await send({ type: "replace", key: "snapshot:target" });
    expect(local().recovery.pins).toEqual([oldPin]);
  });

  it("clears the preserved-pins notice once pins exist again, even while paused", async () => {
    env.loseTabs();
    await vi.advanceTimersByTimeAsync(3000);
    browser.tabs.onRemoved.emit(99, { isWindowClosing: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(local().emptyPinsPreserved).toBe(true);
    await browser.storage.local.set({ paused: true });
    await browser.tabs.create({ url: oldPin.url, pinned: true, windowId: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(local().emptyPinsPreserved).toBeUndefined();
  });
});

describe("backup import through the background", () => {
  it("imports 21 sets and preserves long fields and large pin lists", async () => {
    const sets = Array.from({ length: 21 }, (_, i) => ({ name: `Set ${i}`, pins: [newPin] }));
    sets[0] = { name: "n".repeat(60), pins: [{ url: `https://long.test/?q=${"x".repeat(2100)}`, title: "t".repeat(350) }] };
    sets[1].pins = Array.from({ length: 201 }, () => ({ url: "about:blank", title: "" }));
    const snapshots = Object.fromEntries(sets.map((set, i) => [i, set]));
    const parsed = parseImport(JSON.stringify(buildExport({ snapshots }, 1)));
    await send({ type: "import", sets: parsed });
    expect(local().lastError).toBeUndefined();
    expect(Object.entries(browser.storage.sync._data)
      .filter(([key]) => key.startsWith("snapshot:") && key !== "snapshot:target")
      .map(([, { name, pins }]) => ({ name, pins }))).toEqual(sets);
  });

  it("imports the remaining sets when one set exceeds the sync quota", async () => {
    const good = { name: "Good", pins: [newPin] };
    const huge = { name: "Huge", pins: [{ url: `https://x.test/?q=${"x".repeat(20000)}`, title: "" }] };
    const realSet = browser.storage.sync.set.bind(browser.storage.sync);
    vi.spyOn(browser.storage.sync, "set").mockImplementation(async (records) => {
      if (JSON.stringify(records).length > 8192) throw new Error("QuotaExceededError");
      return realSet(records);
    });
    await send({ type: "import", sets: [huge, good] });
    const stored = Object.entries(browser.storage.sync._data)
      .filter(([key]) => key.startsWith("snapshot:") && key !== "snapshot:target")
      .map(([, { name }]) => name);
    expect(stored).toContain("Good");
    expect(stored).not.toContain("Huge");
    expect(local().lastError.message).toMatch(/1 set/);
  });

  it("trims whitespace around imported set names", async () => {
    await send({ type: "import", sets: [{ name: "  Work \n ", pins: [newPin] }] });
    const names = Object.entries(browser.storage.sync._data)
      .filter(([key]) => key.startsWith("snapshot:") && key !== "snapshot:target")
      .map(([, { name }]) => name);
    expect(names).toEqual(["Work"]);
  });

  it("validates the whole payload before writing any snapshots", async () => {
    const set = vi.spyOn(browser.storage.sync, "set");
    await send({ type: "import", sets: [{ name: "Good", pins: [newPin] }, { name: "Bad", pins: [null] }] });
    expect(set).not.toHaveBeenCalled();
    expect(local().lastError.message).toContain("bad url");
  });

  it("reports an empty backup instead of silently importing nothing", async () => {
    expect(() => parseImport(JSON.stringify(buildExport({}, 1)))).toThrow(/no sets/);
    await send({ type: "import", sets: [] });
    expect(local().lastError.message).toMatch(/no sets/);
  });
});
