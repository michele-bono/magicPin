import { describe, it, expect, beforeEach } from "vitest";
import { applyReplace } from "../src/background/tabsync.js";
import { fakeTabBrowser } from "./helpers/fake-tabs.js";

let env;
beforeEach(() => {
  env = fakeTabBrowser([{ id: 1, url: "https://old.test/", pinned: true, windowId: 1, index: 0 }]);
  globalThis.browser = env.browser;
});

describe("applyReplace", () => {
  it("creates before closing and requests lazy container tabs", async () => {
    const pin = { url: "https://new.test/", title: "New", cookieStoreId: "firefox-container-1" };
    expect(await applyReplace({ close: [1], sequence: [{ create: pin }] })).toBe(0);
    expect(browser.tabs.create).toHaveBeenCalledWith({ ...pin, windowId: 1, pinned: true, active: false, discarded: true });
    expect(browser.tabs.create.mock.invocationCallOrder[0]).toBeLessThan(browser.tabs.remove.mock.invocationCallOrder[0]);
    expect(env.tabs.map((tab) => tab.url)).toEqual([pin.url]);
  });

  it("reuses matching tabs without creating or moving them", async () => {
    expect(await applyReplace({ close: [], sequence: [{ tabId: 1 }] })).toBe(0);
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.tabs.move).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });
});
