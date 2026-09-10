import { vi } from "vitest";
import { fakeBrowser } from "./fake-browser.js";

const event = () => {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.map((listener) => listener(...args)),
    clear: () => { listeners.length = 0; },
  };
};

export function fakeTabBrowser(initialTabs = []) {
  const browser = fakeBrowser();
  let tabs = structuredClone(initialTabs);
  let nextId = Math.max(0, ...tabs.map((tab) => tab.id)) + 1;
  browser.action = {
    setBadgeText: vi.fn(async () => {}),
    setBadgeBackgroundColor: vi.fn(async () => {}),
  };
  browser.windows = { getAll: vi.fn(async () => [{ id: 1, focused: true }]) };
  browser.tabs = {
    onUpdated: event(), onRemoved: event(), onMoved: event(), onAttached: event(),
    query: vi.fn(async ({ pinned }) => structuredClone(tabs.filter((tab) => tab.pinned === pinned))),
    create: vi.fn(async (properties) => {
      if (properties.url === "about:config") throw new Error("Privileged URL");
      const tab = { ...properties, id: nextId++, index: tabs.length, incognito: false };
      tabs.push(tab);
      browser.tabs.onUpdated.emit(tab.id, { pinned: true }, tab);
      return structuredClone(tab);
    }),
    remove: vi.fn(async (id) => {
      tabs = tabs.filter((tab) => tab.id !== id);
      browser.tabs.onRemoved.emit(id, { isWindowClosing: false });
    }),
    move: vi.fn(async (id, { windowId, index }) => {
      const tab = tabs.find((tab) => tab.id === id);
      const fromIndex = tab.index;
      const siblings = tabs.filter((other) => other.windowId === windowId && other.id !== id)
        .sort((a, b) => a.index - b.index);
      siblings.splice(index, 0, tab);
      siblings.forEach((other, i) => { other.index = i; });
      browser.tabs.onMoved.emit(id, { windowId, fromIndex, toIndex: index });
      return structuredClone(tab);
    }),
  };
  Object.assign(browser.runtime, {
    onMessage: event(), onStartup: event(), onInstalled: event(),
    sendMessage: (message) => browser.runtime.onMessage.emit(message)[0],
  });
  return {
    browser,
    get tabs() { return tabs; },
    loseTabs() { tabs = []; },
    resetListeners() {
      for (const area of [browser.tabs, browser.runtime]) {
        for (const value of Object.values(area)) value?.clear?.();
      }
    },
  };
}
