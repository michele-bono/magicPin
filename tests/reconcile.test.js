import { describe, it, expect } from "vitest";
import { computeDiff, computeLocalOrder, navUpdates, dedupeRemotePins } from "../src/background/reconcile.js";

export const pin = (url, title = "t") => ({ url, title, updatedAt: 1 });
export const tab = (tabId, url, { index = 0, windowId = 1, title = "t" } = {}) => ({
  tabId,
  url,
  title,
  index,
  windowId,
});
export const empty = { pins: {}, order: [] };

describe("computeDiff matching", () => {
  it("creates tabs for remote pins with no local match", () => {
    const remote = { pins: { a: pin("https://a.test/") }, order: ["a"] };
    const diff = computeDiff({ remote, localTabs: [], snapshot: empty, tabMap: {} });
    expect(diff.create).toEqual([{ pinId: "a", url: "https://a.test/", title: "t" }]);
    expect(diff.close).toEqual([]);
    expect(diff.upload).toEqual([]);
  });

  it("matches local tabs by existing tabId-to-pinId map even after navigation", () => {
    const remote = { pins: { a: pin("https://a.test/old") }, order: ["a"] };
    const localTabs = [tab(7, "https://a.test/new")];
    const diff = computeDiff({ remote, localTabs, snapshot: empty, tabMap: { 7: "a" } });
    expect(diff.create).toEqual([]);
    expect(diff.map).toEqual({ 7: "a" });
  });

  it("matches unmapped local tabs to remote pins by exact URL", () => {
    const remote = { pins: { a: pin("https://a.test/") }, order: ["a"] };
    const localTabs = [tab(7, "https://a.test/")];
    const diff = computeDiff({ remote, localTabs, snapshot: empty, tabMap: {} });
    expect(diff.create).toEqual([]);
    expect(diff.upload).toEqual([]);
    expect(diff.map).toEqual({ 7: "a" });
  });

  it("uploads local pinned tabs unknown to remote", () => {
    const localTabs = [tab(7, "https://new.test/", { title: "New" })];
    const diff = computeDiff({ remote: empty, localTabs, snapshot: empty, tabMap: {} });
    expect(diff.upload).toEqual([{ tabId: 7, url: "https://new.test/", title: "New" }]);
    expect(diff.close).toEqual([]);
  });

  it("tabId mapping wins over URL match to a different pin", () => {
    const remote = {
      pins: { a: pin("https://old.test/"), b: pin("https://new.test/") },
      order: ["a", "b"],
    };
    const localTabs = [tab(7, "https://new.test/")]; // navigated to b's URL
    const diff = computeDiff({ remote, localTabs, snapshot: empty, tabMap: { 7: "a" } });
    expect(diff.map).toEqual({ 7: "a" }); // tabMap wins
    expect(diff.create).toEqual([{ pinId: "b", url: "https://new.test/", title: "t" }]);
    expect(diff.upload).toEqual([]);
  });

  it("filters ghost IDs from remote.order", () => {
    const remote = {
      pins: { a: pin("https://a.test/"), b: pin("https://b.test/") },
      order: ["b", "ghost1", "a", "ghost2"],
    };
    const diff = computeDiff({ remote, localTabs: [], snapshot: empty, tabMap: {} });
    expect(diff.order).toEqual(["b", "a"]);
  });

  it("handles create, match, and upload in a single call", () => {
    const remote = {
      pins: { a: pin("https://a.test/"), b: pin("https://b.test/") },
      order: ["a", "b"],
    };
    const localTabs = [
      tab(7, "https://a.test/"), // URL-matched to pin a
      tab(8, "https://unknown.test/"), // no remote pin -> upload
    ];
    const diff = computeDiff({ remote, localTabs, snapshot: empty, tabMap: {} });
    expect(diff.map).toEqual({ 7: "a" });
    expect(diff.create).toEqual([{ pinId: "b", url: "https://b.test/", title: "t" }]);
    expect(diff.upload).toEqual([{ tabId: 8, url: "https://unknown.test/", title: "t" }]);
  });
});

describe("computeDiff three-way deletions", () => {
  it("closes local tabs whose pin was deleted on another device", () => {
    const snapshot = { pins: { a: pin("https://a.test/") }, order: ["a"] };
    const diff = computeDiff({
      remote: empty,
      localTabs: [tab(7, "https://a.test/")],
      snapshot,
      tabMap: { 7: "a" },
    });
    expect(diff.close).toEqual([7]);
    expect(diff.upload).toEqual([]);
  });

  it("uploads pins created while offline instead of closing them", () => {
    const snapshot = { pins: { a: pin("https://a.test/") }, order: ["a"] };
    const remote = { pins: { a: pin("https://a.test/") }, order: ["a"] };
    const localTabs = [tab(7, "https://a.test/"), tab(8, "https://new.test/")];
    const diff = computeDiff({
      remote,
      localTabs,
      snapshot,
      tabMap: { 7: "a", 8: "offline-new-id" },
    });
    expect(diff.close).toEqual([]);
    expect(diff.upload).toEqual([{ tabId: 8, url: "https://new.test/", title: "t" }]);
  });

  it("uploads tabs with stale mappings absent from both snapshot and remote", () => {
    const diff = computeDiff({
      remote: empty,
      localTabs: [tab(7, "https://a.test/")],
      snapshot: empty,
      tabMap: { 7: "ghost" },
    });
    expect(diff.close).toEqual([]);
    expect(diff.upload).toEqual([{ tabId: 7, url: "https://a.test/", title: "t" }]);
  });

  it("tolerates a missing tabMap", () => {
    const diff = computeDiff({
      remote: empty,
      localTabs: [tab(7, "https://a.test/")],
      snapshot: empty,
      tabMap: undefined,
    });
    expect(diff.close).toEqual([]);
    expect(diff.upload).toEqual([{ tabId: 7, url: "https://a.test/", title: "t" }]);
  });
});

describe("computeLocalOrder", () => {
  it("sorts by window then index, skipping unmapped tabs", () => {
    const tabs = [
      tab(1, "https://a.test/", { windowId: 2, index: 0 }),
      tab(2, "https://b.test/", { windowId: 1, index: 1 }),
      tab(3, "https://c.test/", { windowId: 1, index: 0 }),
      tab(4, "https://d.test/", { windowId: 1, index: 2 }),
    ];
    const order = computeLocalOrder(tabs, { 1: "pa", 2: "pb", 3: "pc" });
    expect(order).toEqual(["pc", "pb", "pa"]);
  });

  it("returns [] for empty input and for fully unmapped tabs", () => {
    expect(computeLocalOrder([], { 1: "pa" })).toEqual([]);
    expect(computeLocalOrder(undefined, {})).toEqual([]);
    expect(computeLocalOrder([tab(1, "https://a.test/")], {})).toEqual([]);
  });
});

describe("navUpdates (merge-on-write)", () => {
  it("updates urls only for pins this device navigated", () => {
    const remotePins = { a: pin("https://a.test/old"), b: pin("https://b.test/old") };
    const localTabs = [
      tab(1, "https://a.test/new", { title: "A" }),
      tab(2, "https://b.test/new"),
    ];
    const set = navUpdates({
      navigatedPinIds: ["a"],
      tabMap: { 1: "a", 2: "b" },
      localTabs,
      remotePins,
      now: 99,
    });
    expect(set).toEqual({ a: { url: "https://a.test/new", title: "A", updatedAt: 99 } });
  });

  it("skips navigated pins whose tab is gone or url unchanged", () => {
    const remotePins = { a: pin("https://a.test/") };
    const set = navUpdates({
      navigatedPinIds: ["a", "ghost"],
      tabMap: { 1: "a" },
      localTabs: [tab(1, "https://a.test/")],
      remotePins,
      now: 99,
    });
    expect(set).toEqual({});
  });

  it("returns updates for multiple navigated pins at once", () => {
    const remotePins = { a: pin("https://a.test/old"), b: pin("https://b.test/old") };
    const localTabs = [
      tab(1, "https://a.test/new", { title: "A" }),
      tab(2, "https://b.test/new", { title: "B" }),
    ];
    const set = navUpdates({
      navigatedPinIds: ["a", "b"],
      tabMap: { 1: "a", 2: "b" },
      localTabs,
      remotePins,
      now: 99,
    });
    expect(set).toEqual({
      a: { url: "https://a.test/new", title: "A", updatedAt: 99 },
      b: { url: "https://b.test/new", title: "B", updatedAt: 99 },
    });
  });
});

describe("dedupeRemotePins", () => {
  it("returns ids to delete for url duplicates, keeping the smallest id", () => {
    const pins = {
      b: pin("https://a.test/"),
      a: pin("https://a.test/"),
      c: pin("https://c.test/"),
    };
    expect(dedupeRemotePins(pins)).toEqual(["b"]);
  });

  it("returns [] when all urls are distinct or pins are empty", () => {
    expect(dedupeRemotePins({ a: pin("https://a.test/"), b: pin("https://b.test/") })).toEqual([]);
    expect(dedupeRemotePins({})).toEqual([]);
    expect(dedupeRemotePins(undefined)).toEqual([]);
  });

  it("removes all but one of three duplicates deterministically", () => {
    const pins = {
      c: pin("https://x.test/"),
      a: pin("https://x.test/"),
      b: pin("https://x.test/"),
    };
    expect(dedupeRemotePins(pins).sort()).toEqual(["b", "c"]);
  });
});
