import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "./helpers/fake-browser.js";
import * as store from "../src/background/store.js";

beforeEach(() => {
  globalThis.browser = fakeBrowser();
});

const pinA = { url: "https://a.test/", title: "A", updatedAt: 1 };
const pinB = { url: "https://b.test/", title: "B", updatedAt: 1 };

describe("store", () => {
  it("round-trips pins through prefixed sync keys", async () => {
    await store.writePins({ set: { a: pinA }, order: ["a"] });
    expect(await store.readRemote()).toEqual({ pins: { a: pinA }, order: ["a"] });
    expect(globalThis.browser.storage.sync._data["pin:a"]).toEqual(pinA);
  });

  it("removes pins by id", async () => {
    await store.writePins({ set: { a: pinA, b: pinB }, order: ["a", "b"] });
    await store.writePins({ remove: ["a"], order: ["b"] });
    expect(await store.readRemote()).toEqual({ pins: { b: pinB }, order: ["b"] });
  });

  it("defaults local state to empty", async () => {
    expect(await store.readSnapshot()).toEqual({ pins: {}, order: [] });
    expect(await store.readTabMap()).toEqual({});
    expect(await store.readPaused()).toBe(false);
  });

  it("ensureSchema stamps v1, accepts v2, rejects newer versions", async () => {
    await store.ensureSchema();
    expect(globalThis.browser.storage.sync._data.meta).toEqual({ schemaVersion: 1 });
    await globalThis.browser.storage.sync.set({ meta: { schemaVersion: 2 } });
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    await globalThis.browser.storage.sync.set({ meta: { schemaVersion: 3 } });
    await expect(store.ensureSchema()).rejects.toThrow(/unsupported/);
  });

  it("ensureContainerSchema bumps to v2 once and is idempotent", async () => {
    await store.ensureSchema();
    await store.ensureContainerSchema();
    expect(globalThis.browser.storage.sync._data.meta).toEqual({ schemaVersion: 2 });
    await store.ensureContainerSchema();
    expect(globalThis.browser.storage.sync._data.meta).toEqual({ schemaVersion: 2 });
  });

  it("round-trips snapshot through local storage", async () => {
    const snap = { pins: { a: pinA }, order: ["a"] };
    await store.writeSnapshot(snap);
    expect(await store.readSnapshot()).toEqual(snap);
    expect(globalThis.browser.storage.local._data.snapshot).toEqual(snap);
  });

  it("round-trips tabMap through session storage", async () => {
    await store.writeTabMap({ 7: "pin-a" });
    expect(await store.readTabMap()).toEqual({ 7: "pin-a" });
    expect(globalThis.browser.storage.session._data.tabMap).toEqual({ 7: "pin-a" });
  });

  it("writeLastSync persists to local storage", async () => {
    await store.writeLastSync(12345);
    expect(globalThis.browser.storage.local._data.lastSync).toBe(12345);
  });

  it("readRemote tolerates a corrupted order value", async () => {
    await globalThis.browser.storage.sync.set({ "pin:a": pinA, order: "garbage" });
    expect(await store.readRemote()).toEqual({ pins: { a: pinA }, order: [] });
  });
});
