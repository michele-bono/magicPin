import { describe, it, expect, vi } from "vitest";
import { debounce } from "../src/background/util.js";

describe("debounce", () => {
  it("collapses rapid calls into one trailing call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d();
    d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes the latest arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d("first");
    d("second");
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith("second");
    vi.useRealTimers();
  });
});
