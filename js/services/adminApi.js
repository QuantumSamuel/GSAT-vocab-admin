// ============================================================
// 管理員專用 API 封裝（3.3.0）：需要 service_role 才能做的操作
// 【關聯註記】呼叫 Supabase Edge Function（由管理者部署）；
//   使用 services/auth.js 的 getAccessToken；軟刪除走 RPC（admin.js 直接呼叫），
//   本檔只管「需要 service_role 的操作」：重置密碼／硬刪除
// 5.1.x 清理：admin_action 備援名稱移除——該 Edge Function 已自專案消失
//   （404 實測 2026-10-02），備援路徑自 4.2.0 起永遠走不到，留著只會多一次
//   注定失敗的請求；日後若整併名稱，改這裡的 FN 一處即可。
// 【admin-site 抽取註記】設定載入來源由 sync.js 改為 config.js（loadSupabaseConfig 契約相同）；
//   本檔不含任何 service_role 金鑰，高權限動作一律由既有 Edge Function 以管理員 JWT 授權。
// ============================================================
import { getAccessToken } from './auth.js';
import { loadSupabaseConfig } from './config.js';

const FN = 'smart-api';

/**
 * 呼叫 admin 用 Edge Function。
 * @param {string} action  動作名（reset_password / hard_delete / …）
 * @param {string} targetUid 目標帳號 uid
 * @param {object} extra  附加參數（例如 { newPassword: '00000000' }）
 */
export async function edgeAdminAction(action, targetUid, extra = {}) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const token = await getAccessToken();
  if (!token) throw new Error('尚未登入');

  let res;
  try {
    res = await fetch(`${config.url}/functions/v1/${FN}`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, targetUid, ...extra }),
    });
  } catch (err) {
    // 網路層失敗（含被刪除函式的 404 無 CORS 標頭被瀏覽器攔）
    throw new Error(`無法連到 Edge Function（${FN}）：${String(err.message || err)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const detail = data?.error || data?.message || data?.detail;
  throw new Error(detail ? String(detail) : `Edge Function HTTP ${res.status}`);
}

// 重置密碼為 8 個 0（使用者首次登入後自行更改）
export async function adminResetPassword(uid, newPassword = '00000000') {
  return edgeAdminAction('reset_password', uid, { newPassword });
}

// 硬刪除帳號（不可復原；後端以 service_role 執行）
export async function adminHardDelete(uid) {
  return edgeAdminAction('hard_delete', uid);
}
