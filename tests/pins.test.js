import { describe, it, expect } from "vitest";
import { serializePins, pinsEqual, planReplace, planMerge } from "../src/background/pins.js";

const tab = (tabId, url, { index = 0, windowId = 1, title = "t", cookieStoreId } = {}) => ({
  tabId,
  url,
  title,
  index,
  windowId,
  ...(cookieStoreId ? { cookieStoreId } : {}),
});

describe("serializePins", () => {
  it("orders by window then index and keeps non-default containers", () => {
    const tabs = [
      tab(1, "https://b.test/", { windowId: 2, index: 0 }),
      tab(2, "https://a.test/", { windowId: 1, index: 1, cookieStoreId: "firefox-container-1" }),
      tab(3, "https://c.test/", { windowId: 1, index: 0, cookieStoreId: "firefox-default" }),
    ];
    expect(serializePins(tabs)).toEqual([
      { url: "https://c.test/", title: "t" },
      { url: "https://a.test/", title: "t", cookieStoreId: "firefox-container-1" },
      { url: "https://b.test/", title: "t" },
    ]);
  });

  it("returns [] for empty or missing input", () => {
    expect(serializePins([])).toEqual([]);
    expect(serializePins(undefined)).toEqual([]);
  });
});

describe("pinsEqual", () => {
  const a = { url: "https://a.test/", title: "A" };

  it("compares by url, container, and order — not by title", () => {
    expect(pinsEqual([a], [{ url: "https://a.test/", title: "(2) A" }])).toBe(true);
    expect(pinsEqual([a], [{ url: "https://a.test/x", title: "A" }])).toBe(false);
    expect(
      pinsEqual([a], [{ url: "https://a.test/", title: "A", cookieStoreId: "firefox-container-1" }])
    ).toBe(false);
    expect(pinsEqual([a, a], [a])).toBe(false);
    expect(pinsEqual(undefined, [])).toBe(true);
  });

  it("treats missing container and firefox-default as equal", () => {
    expect(
      pinsEqual([a], [{ url: "https://a.test/", title: "A", cookieStoreId: "firefox-default" }])
    ).toBe(true);
  });
});

describe("planReplace", () => {
  it("reuses matching tabs, creates missing pins, closes the rest", () => {
    const local = [
      tab(1, "https://keep.test/"),
      tab(2, "https://close.test/"),
      tab(3, "https://wrong-container.test/"),
    ];
    const target = [
      { url: "https://new.test/", title: "N", cookieStoreId: "firefox-container-1" },
      { url: "https://keep.test/", title: "K" },
      { url: "https://wrong-container.test/", title: "W", cookieStoreId: "firefox-container-2" },
    ];
    const plan = planReplace(local, target);
    expect(plan.sequence).toEqual([
      { create: { url: "https://new.test/", title: "N", cookieStoreId: "firefox-container-1" } },
      { tabId: 1 },
      {
        create: {
          url: "https://wrong-container.test/",
          title: "W",
          cookieStoreId: "firefox-container-2",
        },
      },
    ]);
    expect(plan.close.sort()).toEqual([2, 3]);
  });

  it("matches duplicate identities one-to-one in order", () => {
    const local = [tab(1, "https://a.test/"), tab(2, "https://a.test/")];
    const target = [{ url: "https://a.test/", title: "A" }];
    const plan = planReplace(local, target);
    expect(plan.sequence).toEqual([{ tabId: 1 }]);
    expect(plan.close).toEqual([2]);
  });

  it("replacing with an empty set closes everything", () => {
    const plan = planReplace([tab(1, "https://a.test/")], []);
    expect(plan).toEqual({ close: [1], sequence: [] });
  });
});

describe("planMerge", () => {
  it("creates only missing pins and closes nothing", () => {
    const local = [tab(1, "https://keep.test/"), tab(2, "https://extra.test/")];
    const target = [
      { url: "https://keep.test/", title: "K" },
      { url: "https://new.test/", title: "N", cookieStoreId: "firefox-container-1" },
    ];
    const plan = planMerge(local, target);
    expect(plan.close).toEqual([]);
    expect(plan.sequence).toEqual([
      { tabId: 1 },
      { tabId: 2 },
      { create: { url: "https://new.test/", title: "N", cookieStoreId: "firefox-container-1" } },
    ]);
  });

  it("preserves current local order and appends creates", () => {
    const local = [
      tab(1, "https://b.test/", { index: 1 }),
      tab(2, "https://a.test/", { index: 0 }),
    ];
    const plan = planMerge(local, [{ url: "https://c.test/", title: "C" }]);
    expect(plan.sequence).toEqual([
      { tabId: 2 },
      { tabId: 1 },
      { create: { url: "https://c.test/", title: "C" } },
    ]);
  });

  it("is a no-op plan when the single target pin already exists (addPin case)", () => {
    const local = [tab(1, "https://a.test/")];
    const plan = planMerge(local, [{ url: "https://a.test/", title: "A" }]);
    expect(plan.close).toEqual([]);
    expect(plan.sequence).toEqual([{ tabId: 1 }]);
  });

  it("respects container identity when deciding what is missing", () => {
    const local = [tab(1, "https://a.test/")];
    const plan = planMerge(local, [
      { url: "https://a.test/", title: "A", cookieStoreId: "firefox-container-1" },
    ]);
    expect(plan.sequence).toEqual([
      { tabId: 1 },
      { create: { url: "https://a.test/", title: "A", cookieStoreId: "firefox-container-1" } },
    ]);
  });
});
