import { describe, it, expect } from "vitest";
import { buildExport, parseImport, FORMAT_VERSION } from "../src/background/portable.js";

const pin = (url, extra = {}) => ({ url, title: "t", ...extra });

describe("buildExport / parseImport roundtrip", () => {
  it("exports devices and snapshots as named sets and parses them back", () => {
    const devices = { d1: { name: "Laptop", updatedAt: 5, pins: [pin("https://a.test/")] } };
    const snapshots = {
      s1: {
        name: "Work",
        updatedAt: 6,
        pins: [pin("https://b.test/", { cookieStoreId: "firefox-container-1" })],
      },
    };
    const out = buildExport({ devices, snapshots }, 99);
    expect(out.magicPin).toBe(FORMAT_VERSION);
    expect(out.exportedAt).toBe(99);
    const sets = parseImport(JSON.stringify(out));
    expect(sets).toEqual([
      { name: "Laptop", pins: [{ url: "https://a.test/", title: "t" }] },
      {
        name: "Work",
        pins: [{ url: "https://b.test/", title: "t", cookieStoreId: "firefox-container-1" }],
      },
    ]);
  });

  it("preserves non-http urls (pinned about: pages) through the roundtrip", () => {
    const out = buildExport(
      { devices: { d: { name: "D", updatedAt: 1, pins: [pin("about:reader")] } } },
      1
    );
    expect(parseImport(JSON.stringify(out))[0].pins[0].url).toBe("about:reader");
  });
});

describe("parseImport rejection", () => {
  it("rejects junk, wrong format, and empty files with readable messages", () => {
    expect(() => parseImport("{nope")).toThrow(/JSON/);
    expect(() => parseImport('{"foo":1}')).toThrow(/magicPin/);
    expect(() => parseImport('{"magicPin":1,"sets":[]}')).toThrow(/no sets/);
  });

  it("rejects malformed sets and pins", () => {
    expect(() => parseImport('{"magicPin":1,"sets":[{"pins":[]}]}')).toThrow(/name/);
    expect(() =>
      parseImport('{"magicPin":1,"sets":[{"name":"X","pins":[{"title":"no url"}]}]}')
    ).toThrow(/url/);
  });

  it("trims and caps names, strips default containers and junk fields", () => {
    const text = JSON.stringify({
      magicPin: 1,
      sets: [
        {
          name: `  ${"x".repeat(60)}  `,
          pins: [
            { url: "https://a.test/", title: 5, cookieStoreId: "firefox-default", evil: true },
          ],
        },
      ],
    });
    const [set] = parseImport(text);
    expect(set.name).toHaveLength(40);
    expect(set.pins).toEqual([{ url: "https://a.test/", title: "" }]);
  });
});

describe("buildExport robustness", () => {
  it("skips malformed records so its output always re-imports", () => {
    const devices = {
      good: { name: "OK", updatedAt: 1, pins: [pin("https://a.test/")] },
      noPins: { name: "Broken", updatedAt: 1 },
      nullRec: null,
      badPin: { name: "BadPin", updatedAt: 1, pins: [null] },
    };
    const out = buildExport({ devices }, 1);
    expect(out.sets.map((s) => s.name)).toEqual(["OK"]);
    expect(() => parseImport(JSON.stringify(out))).not.toThrow();
  });
});
