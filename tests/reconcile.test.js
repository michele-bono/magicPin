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
});
