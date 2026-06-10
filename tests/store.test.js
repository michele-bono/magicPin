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

  it("ensureSchema stamps v1 and rejects newer versions", async () => {
    await store.ensureSchema();
    expect(globalThis.browser.storage.sync._data.meta).toEqual({ schemaVersion: 1 });
    await globalThis.browser.storage.sync.set({ meta: { schemaVersion: 2 } });
    await expect(store.ensureSchema()).rejects.toThrow(/unsupported/);
  });
});
