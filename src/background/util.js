export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await fn(...args);
      } catch (e) {
        console.error("magicPin: debounced call failed", e);
      }
    }, ms);
  };
}
