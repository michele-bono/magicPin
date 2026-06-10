// Minimal in-memory stand-in for browser.storage.{sync,local,session}.
export function fakeBrowser() {
  const makeArea = () => {
    const data = {};
    return {
      async get(keys) {
        if (keys === null) return structuredClone(data);
        const ks = Array.isArray(keys) ? keys : [keys];
        return structuredClone(
          Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, data[k]]))
        );
      },
      async set(obj) {
        Object.assign(data, structuredClone(obj));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete data[k];
      },
      _data: data,
    };
  };
  return { storage: { sync: makeArea(), local: makeArea(), session: makeArea() } };
}
