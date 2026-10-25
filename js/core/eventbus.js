// ============================================================
// 事件匯流排（3.0.3 分層重構）：模組間通訊的唯一通道
// 頁面/服務互相溝通一律 emit/on，不再直接引用彼此內部狀態
// 除錯：localStorage 設 vocab2_debug=1 可在 console 看所有事件
// ============================================================

const listeners = new Map();
const DEBUG = (() => {
  try { return localStorage.getItem('vocab2_debug') === '1'; } catch { return false; }
})();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => off(event, fn); // 回傳取消函式
}

export function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

export function emit(event, data = null) {
  if (DEBUG) console.debug(`[bus] ${event}`, data);
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(data);
    } catch (err) {
      console.warn(`事件處理失敗（${event}）：`, err);
    }
  }
}
