// ============================================================
// 權益閘（3.0.3 預留槽位、3.1.0 接上角色）：付費功能入口＋後台管理入口
// canManage()＝後台管理（由登入後的 profile.role 驅動，auth.js 呼叫 setRoleCache）
// isPro()＝付費解鎖位（4.0 變現時接後端權益表；現為本機旗標槽位）
// ============================================================

const KEY_PRO = 'vocab2_entitlements';
let roleCache = null; // 'user' | 'admin' | null（未登入）

export function setRoleCache(role) {
  roleCache = role === 'admin' ? 'admin' : role ? 'user' : null;
}

export function canManage() {
  return roleCache === 'admin';
}

function read() {
  try { return JSON.parse(localStorage.getItem(KEY_PRO)) || {}; } catch { return {}; }
}

export function isPro() {
  return read().pro === true;
}
