import { describe, it, expect, vi, afterEach } from "vitest";
import { debounce } from "../src/background/util.js";

afterEach(() => {
  vi.useRealTimers();
});

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
  });

  it("passes the latest arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d("first");
    d("second");
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("resets the timer on each call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.advanceTimersByTime(90);
    d();
    vi.advanceTimersByTime(90);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("logs instead of throwing when an async callback rejects", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = debounce(async () => {
      throw new Error("boom");
    }, 10);
    d();
    await vi.advanceTimersByTimeAsync(10);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
