import { describe, it, expect, vi, afterEach } from "vitest";
import { markEcho, isEcho } from "../src/background/tabsync.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("echo suppression", () => {
  it("marks a tab as self-mutated and expires the mark", () => {
    vi.useFakeTimers();
    markEcho(42);
    expect(isEcho(42)).toBe(true);
    expect(isEcho(43)).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(isEcho(42)).toBe(false);
  });
});
