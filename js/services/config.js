// ============================================================
// 站點設定（admin-site 專用）——公開設定，不含任何私密憑證
//
// 來源：6.0/6.1.2/js/services/sync.js 的 loadSupabaseConfig()（原樣搬過來，
//   只把「設定檔名」抽成常數、並加上 service_role 防呆，見下方 assertPublicKey）。
//   後台獨立站不需要原站的雲端快照／IndexedDB 同步，故不引入整個 sync.js。
//
// 契約（與原站一致，呼叫端不必改）：
//   { url, key, configured: true }
//   { url:'', key:'', configured:false, error }                          // 未設定／缺檔
//   { url:'', key:'', configured:false, error, failure:'network' }       // 真網路失敗
//   { url:'', key:'', configured:false, error, failure:'http', status }  // 設定檔 HTTP 非 2xx
//   { url:'', key:'', configured:false, error, failure:'forbidden-key' } // 偵測到 service_role
// ============================================================

// 部署時把 supabase_config.txt 填上「Project URL」與「anon public key」兩行。
// 只允許公開金鑰（anon／publishable）；service_role 一律拒絕載入。
export const CONFIG_FILE = 'supabase_config.txt';

/**
 * 判斷金鑰是否為高權限（service_role）。
 * 為什麼要擋：後台前端只需要 anon key + 管理員 JWT，所有授權都在 RPC／RLS 後端。
 *   若有人把 service_role 填進前端設定檔，等於把整個資料庫的萬用金鑰送到瀏覽器。
 * Supabase 的舊式金鑰是 JWT（payload 內有 "role":"service_role"）；
 * 新式 publishable 金鑰以 sb_publishable_ 開頭（非 JWT）→ 直接放行。
 */
export function isForbiddenKey(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  if (/^sb_publishable_/i.test(k)) return false;
  if (/^sb_secret/i.test(k)) return true;
  const parts = k.split('.');
  if (parts.length !== 3) return false; // 非 JWT：交給後端授權判斷
  try {
    // Node（測試、本機工具）有 Buffer；瀏覽器用 atob。兩邊都要支援 base64url。
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const json = typeof Buffer !== 'undefined'
      ? Buffer.from(b64, 'base64').toString('utf8')
      : decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json)?.role === 'service_role';
  } catch {
    // 解不開就退回寬鬆字串比對（寧可誤擋，不可把高權限金鑰送進瀏覽器）
    return /service_role/.test(k);
  }
}

export async function loadSupabaseConfig() {
  let res;
  try {
    res = await fetch(CONFIG_FILE, { cache: 'no-cache' });
  } catch (err) {
    // 真網路失敗（離線／DNS／TLS）：fetch 直接 reject，沒有任何 HTTP 回應，不可吞成「未設定」。
    return { url: '', key: '', configured: false, error: String(err), failure: 'network' };
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) {
      // 設定檔真的不存在 → 未設定（NOT_CONFIGURED），不是網路錯誤。
      return { url: '', key: '', configured: false, error: `HTTP ${res.status}` };
    }
    // 5xx＝暫時性；401／403＝存取被拒；其餘非 2xx 一律視為設定檔 HTTP 失敗，含原 status。
    return { url: '', key: '', configured: false, error: `HTTP ${res.status}`, failure: 'http', status: res.status };
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    // 讀取回應內容時的真網路失敗。
    return { url: '', key: '', configured: false, error: String(err), failure: 'network' };
  }
  let url = '', key = '';
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*(Project URL|anon key)\s*=\s*(.+?)\s*$/i);
    if (!m) continue;
    if (m[1].toLowerCase().startsWith('project')) url = m[2].replace(/^#/, '').trim();
    else key = m[2].replace(/^#/, '').trim();
  }
  // 未設定時設定檔是「# Project URL=」註解狀態 → 值為空
  if (url && !url.startsWith('https://')) url = '';
  if (url && key && isForbiddenKey(key)) {
    // 不可把高權限金鑰送到瀏覽器：整份設定視為不可用，訊息不含金鑰內容
    return {
      url: '', key: '', configured: false, failure: 'forbidden-key',
      error: '設定檔內偵測到 service_role／高權限金鑰，後台僅允許 anon public key。請改用公開金鑰。',
    };
  }
  return { url, key, configured: Boolean(url && key) };
}
