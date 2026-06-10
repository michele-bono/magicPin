import { describe, it, expect } from "vitest";
import { computeDiff } from "../src/background/reconcile.js";

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
    const diff = computeDiff({ remote, localTabs, snapshot, tabMap: { 7: "a" } });
    expect(diff.close).toEqual([]);
    expect(diff.upload).toEqual([{ tabId: 8, url: "https://new.test/", title: "t" }]);
  });
});
