// ============================================================
// 帳號系統（admin-site 版）——Supabase Auth（Email＋密碼），REST 呼叫、零依賴
//
// 來源：6.0/6.1.2/js/services/auth.js（逐段搬過來，只做「後台獨立站」必要調整）
//  ① SESSION_KEY 改為 vocab2_admin_session：登入狀態與學習站（vocab2_session）完全分離，
//     同一瀏覽器同一 origin 或不同 origin 都不會互相覆蓋（原站與新站各自重新登入）。
//  ② 移除學習站專屬流程：金鑰註冊／OTP 驗證碼／修改密碼（後台沒有註冊與帳號頁；
//     管理員密碼仍由 Supabase 帳號系統管理，不在本輪另做）。
//  ③ 新增 refreshProfile()：重登／手動刷新時重新抓 profile 與角色，供權限刷新使用。
// 其餘（token 續期、generation 守衛、storage 跨分頁失效、restFetch 契約）與原站一致。
//
// 安全：所有資料表存取靠 RLS；金鑰只有 anon key（公開設計），無 service_role。
// ============================================================
import { loadSupabaseConfig } from './config.js';
import { setRoleCache } from '../core/entitlements.js';
import { emit } from '../core/eventbus.js';

// 【隔離】與學習站的 vocab2_session 不同鍵：後台必須重新登入，且登出互不影響。
export const SESSION_KEY = 'vocab2_admin_session';

let session = loadSession();   // { access_token, refresh_token, expires_at, user:{id,email} }
let profile = null;            // { role, banned, email, ... }（登入後載入）
let authGeneration = 0;        // session 邊界；同帳戶登出再登入也不同

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}

function saveSession(s, { preserveGeneration = false } = {}) {
  if (!preserveGeneration || session?.user?.id !== s?.user?.id) authGeneration++;
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

export function getUser() { return session?.user ?? null; }
export function getAuthGeneration() { return authGeneration; }
export function isLoggedIn() { return Boolean(session?.access_token); }
export function getProfile() { return profile; }

// storage 在另一分頁觸發；立即失效先前 session 的在途回應。
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== SESSION_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== localStorage) return;
  authGeneration++;
  const previousOwner = session?.user?.id;
  session = loadSession();
  if (!session || session.user?.id !== previousOwner) {
    profile = null;
    setRoleCache(null);
  }
  emit('auth:changed', getUser());
});

function translateAuthError(msg) {
  const m = String(msg);
  if (/Invalid login credentials/i.test(m)) return '帳號或密碼錯誤';
  if (/Email not confirmed/i.test(m)) return 'Email 尚未驗證：請管理員處理後再登入';
  if (/at least/i.test(m)) return '密碼至少 8 碼';
  if (/rate limit|Too many/i.test(m)) return '嘗試太頻繁，請稍後再試';
  if (/unable to validate/i.test(m)) return 'Email 格式不正確';
  return m;
}

async function authFetch(config, path, body, token) {
  const res = await fetch(`${config.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(translateAuthError(data.error_description || data.msg || data.message || `HTTP ${res.status}`));
  return data;
}

function persistAuth(data, options) {
  if (!data.access_token) return; // 需 email 驗證等情境：無 session
  saveSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    user: { id: data.user?.id, email: data.user?.email },
  }, options);
}

// 產生 16 位金鑰（大小寫字母＋數字；排除易混淆字元），後台「產生金鑰」用
export function generateInviteKey() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 4.0.2：全大寫（與 check_invite 的大寫比對一致，並排除 I/O 混淆）
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => CHARS[b % CHARS.length]).join('');
}

// 金鑰格式驗證（前端先驗；真正的有效性由後端 check_invite 把關）
// 4.0.2：自定義金鑰放寬為 4～40 位（字母、數字、-、_）；產生金鑰固定 16 位全大寫
export function isValidInviteKey(key) {
  return /^[A-Za-z0-9_-]{4,40}$/.test(String(key || '').trim());
}

// ---------- 對外：登入／登出 ----------
export async function signIn(email, password) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const data = await authFetch(config, 'token?grant_type=password', { email, password });
  persistAuth(data);
  await afterLogin();
  return getUser();
}

export async function signOut() {
  const generation = authGeneration;
  const config = await loadSupabaseConfig();
  if (authGeneration !== generation) return;
  try {
    if (session?.access_token && config.configured) {
      await authFetch(config, 'logout', null, session.access_token);
    }
  } catch { /* 登出以本地為準 */ }
  if (authGeneration !== generation) return; // 等待期間另一分頁已接手登入態
  saveSession(null);
  profile = null;
  setRoleCache(null);
  emit('auth:changed', null);
}

// ---------- Token 續期 ----------
async function ensureFreshToken() {
  if (!session) return null;
  if (session.expires_at - Date.now() > 60_000) return session.access_token;
  const previousSession = session;
  const generation = authGeneration;
  const config = await loadSupabaseConfig();
  const data = await authFetch(config, 'token?grant_type=refresh_token', { refresh_token: previousSession.refresh_token });
  if (authGeneration !== generation || session !== previousSession) throw new Error('登入帳戶已變更，未採用舊的更新回應');
  persistAuth(data, { preserveGeneration: true });
  return session.access_token;
}

export async function getAccessToken() {
  return ensureFreshToken();
}

// ---------- 登入後：載 profile（角色／停權）＋更新活躍時間 ----------
// 【重登權限刷新】每次登入都重抓 profile，角色／層級／停權以伺服器回傳為準，
//   前端不自行記住上一次的角色（也不以隱藏導航代替授權）。
async function afterLogin() {
  const token = session.access_token;
  const uid = getUser().id;
  const generation = authGeneration;
  const checkSession = () => {
    if (authGeneration !== generation || getUser()?.id !== uid) {
      throw Object.assign(new Error('登入帳戶已變更，未採用舊的個人資料'), { code: 'AUTH_CHANGED' });
    }
  };
  const config = await loadSupabaseConfig();
  checkSession();
  const res = await fetch(`${config.url}/rest/v1/profiles?select=*&id=eq.${uid}`, {
    headers: { apikey: config.key, Authorization: `Bearer ${token}` },
  });
  const rows = await res.json().catch(() => []);
  checkSession();
  if (!res.ok) {
    // 401／403：token 無效或沒權限讀自己的 profile → 當成登入失敗，不進後台
    await signOut().catch(() => {});
    throw new Error(`讀取管理員資料失敗（HTTP ${res.status}）：請重新登入`);
  }
  profile = rows[0] ?? null;
  if (!profile) {
    // 沒有 profile 列（例如帳號被硬刪除但 token 還在）→ 不給任何管理權限
    await signOut();
    throw new Error('查無此帳號的個人資料，請聯絡管理員');
  }
  if (profile.banned) {
    // 4.3.0 修復（Pool B 獵捕）：signOut 會把模組級 profile 設成 null——
    // 旗標必須在 signOut 前取值，否則停權/已註銷分流拋 TypeError
    const isDeleted = profile.deleted === true;
    await signOut();
    // deleted=true＝使用者自行註銷（軟刪除，待管理員永久刪除）——與管理員停權分流
    throw new Error(isDeleted
      ? '此 Email 的帳號已註銷，需管理員永久刪除後才能重新註冊；如有需要請聯絡管理員。'
      : '此帳號已被停用，請聯絡管理員');
  }
  setRoleCache(profile?.role ?? 'user');
  if (profile) {
    await fetch(`${config.url}/rest/v1/profiles?id=eq.${uid}`, {
      method: 'PATCH',
      headers: {
        apikey: config.key, Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ last_seen: new Date().toISOString() }),
    });
    checkSession();
    await restFetch('vocab_usage', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: uid }),
    }).catch(() => {}); // 活躍 ping（每天一筆，失敗不影響）
  }
  checkSession();
  emit('auth:changed', getUser());
}

/**
 * 重新向伺服器確認目前登入者的角色（重登後權限刷新、或管理員被降權時即時生效）。
 * 回傳最新 profile；失敗（401／403／網路）時清掉本機登入態並拋出，不沿用舊權限。
 */
export async function refreshProfile() {
  if (!session) return null;
  const generation = authGeneration;
  await afterLogin();
  if (generation !== authGeneration) throw new Error('登入帳戶已變更，未採用舊的權限資料');
  return profile;
}

// ---------- 帶登入態的 REST（後台各分區共用） ----------
// 未登入時以 anon key 呼叫（僅限 RLS 開放公開讀取的表）
export async function restFetch(path, options = {}) {
  const config = await loadSupabaseConfig();
  const token = await getAccessToken().catch(() => null);
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${token || config.key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    // 401＝無 JWT／過期；403＝RLS 或 RPC 的 is_admin() 拒絕。兩者都要讓呼叫端看見，
    // 不可吞成空陣列（否則後台會顯示「沒有資料」而不是「你沒權限」）。
    throw new Error(`Supabase HTTP ${res.status}：${detail}`);
  }
  // 3.2.0 修復：INSERT 成功（201/204＋return=minimal）回應是空內容，不能 res.json()
  const text = await res.text();
  if (res.status === 204 || !text) return null;
  return JSON.parse(text);
}

// ---------- 啟動（app.js 呼叫一次）：還原會話＋載 profile ----------
// 4.2.0：auth 就緒 promise——冷載時硬閘須等本 promise resolve 後再判斷，
// 否則 initAuth 尚未完成會誤顯「無權限」（既有競態，debug 實證）
let _authReadyResolve; // 須先宣告——promise executor 同步執行，放後面會 TDZ
export const authReady = new Promise((resolve) => { _authReadyResolve = resolve; });

export async function initAuth() {
  const generation = authGeneration;
  try {
    if (!isLoggedIn()) { emit('auth:changed', null); return; }
    await ensureFreshToken();
    await afterLogin();
  } catch (err) {
    if (authGeneration !== generation) return; // 舊的還原失敗不得清除新帳戶
    // 過期／網路失敗：保留本地資料，僅退回未登入
    saveSession(null);
    profile = null;
    setRoleCache(null);
    emit('auth:changed', null);
    console.warn('登入狀態還原失敗：', err.message);
  } finally {
    _authReadyResolve(); // 成功／失敗／未登入，都要解除硬閘的等待
  }
}
