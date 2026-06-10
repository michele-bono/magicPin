import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "./helpers/fake-browser.js";
import * as store from "../src/background/store.js";

beforeEach(() => {
  globalThis.browser = fakeBrowser();
});

const record = (name, pins = []) => ({ name, updatedAt: 1, pins });

describe("store", () => {
  it("round-trips device records through prefixed sync keys", async () => {
    await store.writeDevice("d1", record("Laptop", [{ url: "https://a.test/", title: "A" }]));
    expect(await store.readDevices()).toEqual({
      d1: record("Laptop", [{ url: "https://a.test/", title: "A" }]),
    });
    expect(globalThis.browser.storage.sync._data["device:d1"]).toBeDefined();
  });

  it("removes device records by id", async () => {
    await store.writeDevice("d1", record("Laptop"));
    await store.writeDevice("d2", record("Desktop"));
    await store.removeDevice("d1");
    expect(await store.readDevices()).toEqual({ d2: record("Desktop") });
  });

  it("ensureSchema migrates legacy global-set keys and stamps v3", async () => {
    await globalThis.browser.storage.sync.set({
      meta: { schemaVersion: 2 },
      "pin:a": { url: "https://a.test/" },
      order: ["a"],
      "device:d1": record("Laptop"),
    });
    await store.ensureSchema();
    const data = globalThis.browser.storage.sync._data;
    expect(data.meta).toEqual({ schemaVersion: 3 });
    expect(data["pin:a"]).toBeUndefined();
    expect(data.order).toBeUndefined();
    expect(data["device:d1"]).toBeDefined();
  });

  it("ensureSchema accepts v3 and rejects newer versions", async () => {
    await store.ensureSchema();
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    await globalThis.browser.storage.sync.set({ meta: { schemaVersion: 4 } });
    await expect(store.ensureSchema()).rejects.toThrow(/unsupported/);
  });

  it("generates a stable device identity once", async () => {
    const first = await store.getDeviceIdentity();
    expect(first.deviceId).toBeTruthy();
    expect(first.deviceName).toContain("mac");
    const second = await store.getDeviceIdentity();
    expect(second).toEqual(first);
  });

  it("setDeviceName updates the local name", async () => {
    await store.getDeviceIdentity();
    await store.setDeviceName("Work laptop");
    expect((await store.getDeviceIdentity()).deviceName).toBe("Work laptop");
  });

  it("defaults paused to false", async () => {
    expect(await store.readPaused()).toBe(false);
  });

  it("writeLastSync persists to local storage", async () => {
    await store.writeLastSync(12345);
    expect(globalThis.browser.storage.local._data.lastSync).toBe(12345);
  });
});

describe("snapshots and undo", () => {
  const record = (name, pins = []) => ({ name, updatedAt: 1, pins });

  it("round-trips snapshot records separately from devices", async () => {
    await store.writeDevice("d1", record("Laptop"));
    await store.writeSnapshot("s1", record("Work", [{ url: "https://a.test/", title: "A" }]));
    expect(await store.readSnapshots()).toEqual({
      s1: record("Work", [{ url: "https://a.test/", title: "A" }]),
    });
    expect(await store.readDevices()).toEqual({ d1: record("Laptop") });
  });

  it("removes snapshots by id", async () => {
    await store.writeSnapshot("s1", record("Work"));
    await store.removeSnapshot("s1");
    expect(await store.readSnapshots()).toEqual({});
  });

  it("round-trips the undo slot through local storage", async () => {
    expect(await store.readUndo()).toBeUndefined();
    await store.writeUndo({ pins: [{ url: "https://a.test/", title: "A" }], savedAt: 5 });
    expect(await store.readUndo()).toEqual({
      pins: [{ url: "https://a.test/", title: "A" }],
      savedAt: 5,
    });
    expect(globalThis.browser.storage.local._data.undo).toBeDefined();
  });
});

describe("identity adoption after storage.local loss", () => {
  const pins = [{ url: "https://a.test/", title: "A" }];

  it("re-adopts the unique record matching the live pins", async () => {
    await store.writeDevice("old-id", { name: "My Laptop", updatedAt: 1, pins });
    const identity = await store.getDeviceIdentity(pins);
    expect(identity).toEqual({ deviceId: "old-id", deviceName: "My Laptop" });
    // and it sticks
    expect(await store.getDeviceIdentity()).toEqual(identity);
  });

  it("mints a fresh identity when zero or multiple records match", async () => {
    await store.writeDevice("d1", { name: "A", updatedAt: 1, pins });
    await store.writeDevice("d2", { name: "B", updatedAt: 1, pins });
    const identity = await store.getDeviceIdentity(pins);
    expect(["d1", "d2"]).not.toContain(identity.deviceId);
  });

  it("never adopts on an empty pin set", async () => {
    await store.writeDevice("d1", { name: "A", updatedAt: 1, pins: [] });
    const identity = await store.getDeviceIdentity([]);
    expect(identity.deviceId).not.toBe("d1");
  });
});
