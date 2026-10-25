// ============================================================
// 頁面：後台管理（3.1.0）——限管理員（profile.role='admin'，RLS 雙重保護）
// 【4.2.0 A 節：workspace 化】七區改左欄一級導航＋右欄單區渲染：
//   sys 總覽／keys 註冊金鑰／users 使用者／ann 公告／presets 預設單詞本／
//   usage 平台額度／feedback 反饋；切區走 hash query（#/admin?sec=users）
// 敏感操作走 Supabase RPC（security definer＋is_admin() 檢查，見 setup SQL）
// 【關聯註記】3.3.0：輪詢（startLiveRefresh）只打當前區的 loader，切區由
//   router 的 hashchange 重渲染 renderAdmin 接管（timer 隨之重啟）
// ============================================================
import { restFetch, getProfile, signOut, getAuthGeneration } from '../services/auth.js';
import { el, escapeHtml, ICONS, openDialog, toast, iconInline } from '../core/ui.js';
import { parseWordTokens, verifyTokens, findWord } from '../services/search.js';
import { getWords, loadWords } from '../services/vocab.js';
import { generateInviteKey } from '../services/auth.js';
import { adminResetPassword, adminHardDelete } from '../services/adminApi.js';
import { proAdminCreateCode, proAdminListCodes, proAdminVoidCode, proAdminRevokePro, proAdminListGrants } from '../services/pro-api.js';

const POLL_MS = 20000; // 3.3.0：即時監控輪詢間隔

// ---------- 5.1.9：後台時間一律用裝置（使用者）時區 ----------
// 問題：後台從 Supabase 拿到的 created_at／last_seen／fn_last 都是 UTC ISO 字串，
// 原先用字串切片（slice(0,16)）直接顯示，畫面上看到的是 UTC，不是管理員所在的時區，
// 差 8 小時（台灣）。這裡一律改成「解析成 Date 之後用本機 getter 取年月日时分」，
// 顯示的就是裝置時區。fmtTime 原本就是 new Date()＋getHours()，本來就對，一併收斂成同一組函式。
//
// 刻意不用 toLocaleString()：它會依語系輸出「2026/10/10 上午3:04」這種帶 AM/PM 的字樣，
// 版面寬度會跟著跳；這裡自己排固定格式，版面與既有寫法一致。
const pad2 = (n) => String(n).padStart(2, '0');

/** ISO 字串 → 'YYYY-MM-DD'（裝置時區）；無法解析回傳空字串 */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO 字串 → 'YYYY-MM-DD HH:MM'（裝置時區）；無法解析回傳空字串 */
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${fmtDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO 字串 → 'MM/DD HH:MM'（裝置時區，給 Edge Function 最後呼叫這種窄欄位用）；無法解析回傳 '—' */
function fmtTime(iso) {
  const s = fmtDateTime(iso);
  if (!s) return '—';
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

// 鎖形 SVG（4.1.1：取代 emoji；4.2.0 改用 ICONS.lock 單一來源）——與 core/router.js 的無權限卡同一顆
const LOCK_SVG = ICONS.lock;

// ============================================================
// 4.2.0 A-1：七區註冊表（左欄導航、右欄內容、輪詢對象三合一）
// load：該區的載入函式；editing：區內有輸入框，輪詢需保護不打斷輸入
// title／desc：右欄區塊標題與說明（.tp-page-title＋.tp-secondary）
// icon：只用 ui.js 既有 ICONS；語意對不上的區（使用者／反饋）刻意留白，
//       不拿近似圖示硬湊——寧可無圖示不可加 emoji
// ============================================================
const SECTIONS = [
  {
    id: 'sys', label: '總覽', icon: ICONS.checkCircle,
    title: '系統總覽',
    desc: 'Edge Function 呼叫量、帳號與雲端備份概況，以及 Supabase 免費額度佔用（資料庫 500MB／Storage 1GB）。',
    load: loadSys,
  },
  {
    id: 'keys', label: '註冊金鑰', icon: ICONS.star,
    title: '註冊金鑰管理',
    desc: '金鑰可設使用次數：1＝單次（註冊成功即綁定該帳號並作廢）；2 以上＝可重複使用，達到上限自動失效，清單會顯示已用次數。同學在「註冊」頁輸入金鑰。',
    load: loadKeys, editing: true,
  },
  {
    id: 'users', label: '使用者', icon: ICONS.user,
    title: '使用者管理',
    desc: '停權＝下次啟動時被登出並擋登入；角色與層級變更即時生效。只能操作層級比自己低的帳號（後端也會擋）。',
    load: loadUsers, editing: true,
  },
  {
    id: 'ann', label: '公告', icon: ICONS.volume,
    title: '公告系統',
    desc: '公告顯示在所有使用者的首頁（可關閉）；下架＝不再顯示。同時最多顯示 3 則（最新優先）。',
    load: loadAnnouncements, editing: true,
  },
  {
    id: 'presets', label: '預設單詞本', icon: ICONS.download,
    title: '預設單詞本發佈',
    desc: '發佈後出現在所有使用者的單詞本頁（可展開預覽、一鍵導入）；分組會顯示為標題。更新不需要出新版 App。',
    load: loadPresets, editing: true,
  },
  {
    id: 'usage', label: '平台額度', icon: ICONS.arrowUpRight,
    title: '平台額度與統計',
    desc: '近 14 天活躍人數與使用分鐘數。活躍＝當天有開啟 App 並登入；使用分鐘只計「有操作」的時間。',
    load: loadUsage,
  },
  {
    id: 'feedback', label: '反饋', icon: ICONS.message,
    title: '反饋管理',
    desc: '使用者從右上角「意見反饋」按鈕提交；回復後對方在自己的反饋面板即可看到。',
    load: loadFeedback, editing: true,
  },
  {
    id: 'pro', label: 'Pro 管理', icon: ICONS.star,
    title: 'Pro 管理（6.3.0）',
    desc: '建立 Pro 啟用碼（永久／限期，明碼只顯示一次、請立即複製）、查看啟用碼與授予清單、作廢啟用碼、撤銷使用者 Pro。Pro 兌換顯示「正在開發中」直到此處建立啟用碼並由同學兌換。',
    load: loadPro, editing: true,
  },
];

const DEFAULT_SEC = 'sys';

// 從 hash query 讀目前區塊：#/admin?sec=users（router 的 currentRoute() 已切掉 query，故自取）
function currentSec() {
  const sec = new URLSearchParams(location.hash.split('?')[1] || '').get('sec');
  return SECTIONS.some((s) => s.id === sec) ? sec : DEFAULT_SEC;
}

export async function renderAdmin(main) {
  const profile = getProfile();
  if (profile?.role !== 'admin' || profile?.banned) {
    main.replaceChildren(el(`
      <section class="card error">
        <h2><span class="card-h2-icon">${LOCK_SVG}</span>無權限</h2>
        <p>此頁面僅限管理員使用。請先用管理員帳號登入（同步頁）。</p>
      </section>`));
    return;
  }

  try {
    await loadWords(); // 4.1.0 修復：與其他頁一致——渲染前載字庫；失敗只降級 預設單詞本 區，不炸整頁
  } catch { /* 該區會在驗證時提示 */ }
  if (location.hash.replace(/^#\/?/, '').split('?')[0] !== 'admin') return; // 4.1.0：離頁守衛（字庫載入期間切頁，舊 render 安靜中止）

  const sec = currentSec();
  const cur = SECTIONS.find((s) => s.id === sec);
  const nav = SECTIONS.map((s) => `
    <a class="admin-nav-item ${s.id === sec ? 'active' : ''}" href="#/admin?sec=${s.id}"${s.id === sec ? ' aria-current="page"' : ''}>
      ${s.icon ? `<span class="admin-nav-icon">${s.icon}</span>` : ''}<span class="admin-nav-label">${s.label}</span>
    </a>`).join('');

  main.replaceChildren(el(`
    <div class="admin-shell">
      <nav class="admin-nav" aria-label="後台分區">${nav}</nav>
      <div class="admin-main">
        <div class="admin-bar">
          <div class="live-bar admin-live">
            <span id="live-dot" class="live-dot"></span>
            <span id="live-text">即時監控中 · 每 20 秒更新</span>
          </div>
          <span class="admin-bar-actions">
            <button class="icon-btn icon-btn-sm" id="btn-admin-refresh" title="刷新" aria-label="刷新">${ICONS.refresh}</button>
            <!-- 5.0.4 F 項：登出鈕維持純文字。ICONS 圖庫沒有「離開帳號」語意的圖標，
                 而 SECTIONS 的既有原則就是「語意對不上就留白，不拿近似圖示硬湊」——
                 圖庫缺清單已回報（見回報 F 項），不自繪新 SVG。 -->
            <button class="btn-text" id="btn-admin-logout">登出</button>
          </span>
        </div>
        <section class="card admin-panel-card">
          <!-- 5.0.4 F 項：分區標題列補 SVG 圖標（直接重用左欄同一顆 ICONS；語意對不上的
               分區仍留白——見 SECTIONS 註解，寧可無圖示不加 emoji，也不拿近似圖示硬湊） -->
          <h2 class="tp-page-title">${cur.icon ? `<span class="admin-title-icon">${cur.icon}</span>` : ''}${cur.title}</h2>
          <p class="tp-secondary admin-desc">${cur.desc}</p>
          <p class="tp-caption admin-meta">管理員：${escapeHtml(profile.email || '')}｜所有變更即時生效，由資料庫 RLS 保護。</p>
          <div id="admin-panel"><p class="muted">載入中…</p></div>
        </section>
      </div>
    </div>`));

  main.querySelector('#btn-admin-logout')?.addEventListener('click', async () => {
    await signOut();
    location.hash = '#/login'; // admin-site：登出後回本網站的登入頁（原站為 #/sync）
  });

  const panel = main.querySelector('#admin-panel');

  // 4.2.0 A-6／A-7：只輪詢「當前區」。切區由 hashchange 觸發 router 重渲染，
  // 新一輪 renderAdmin 會 stopLiveRefresh 後以新區重啟 timer（見 startLiveRefresh）。
  const refreshSection = async () => {
    await loadWords().catch(() => {}); // 4.1.0：⟳ 同時重試字庫載入（與 預設單詞本 區提示一致）
    markLive(main);
    if (cur.editing) refreshUnlessEditing(panel, cur.load);
    else cur.load(panel);
  };

  main.querySelector('#btn-admin-refresh')?.addEventListener('click', refreshSection);
  refreshSection();
  startLiveRefresh(refreshSection);
}

// 有輸入框正在被編輯時不重繪該區（避免 20 秒輪詢吃掉使用者打好的字）
function refreshUnlessEditing(box, loader) {
  if (!box) return;
  if (box.contains(document.activeElement)) return;
  loader(box);
}

// ---------- 3.3.0 即時監控：輪詢與狀態列 ----------
let liveTimer = null;

// 刷新時在狀態列標示更新時間（分秒）
function markLive(main) {
  const text = main.querySelector('#live-text');
  if (!text) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  text.textContent = `即時監控中 · 每 20 秒更新 · 最後刷新 ${hh}:${mm}:${ss}`;
}

function startLiveRefresh(onTick) {
  stopLiveRefresh();
  liveTimer = setInterval(() => {
    if (location.hash.replace(/^#\/?/, '').split('?')[0] !== 'admin') { stopLiveRefresh(); return; } // 離頁自停
    onTick();
  }, POLL_MS);
}

function stopLiveRefresh() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

// ============================================================
// 使用者管理（層級徽章＋展開詳情＋分級控制鈕）
// 層級（admin_level）：1=管理員 2=高階 3=根管理員；非管理員視同 0
// 規則與後端 RPC 一致：只能操作層級比自己低的帳號（後端也會擋，前端先擋）
// 「設/撤管理員」與「調層級」僅根管理員（L3）可用；軟刪除需 L2 以上；硬刪除僅 L3
// 【4.0.2】在線狀態點點：閃爍綠＝持續活躍（6 分內有操作）／綠＝在線（10 分內有心跳）／
//   黃＝異常（停權或已刪除）／灰＝離線（last_active 欄位需執行 supabase_400.sql）
// 【4.2.0】6 顆操作鈕收進「⋯」小選單（複用 .user-menu 樣式，掛在 body 不受表格捲動裁切）；
//   搜尋與四種篩選在 client 端套用，不重打 API
// ============================================================
const COLLAPSED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const EXPANDED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';

let userQuery = '';     // 搜尋關鍵字（Email／帳號 ID）
let userFilter = 'all'; // all | admin | banned | deleted
let userRows = [];      // 最近一次抓回的列（搜尋／篩選在 client 端套用）
let usersBox = null;    // 目前的使用者區容器（動作完成後回刷用）

const FILTERS = [
  ['all', '全部'], ['admin', '管理員'], ['banned', '停權'], ['deleted', '已刪'],
];

const levelLabel = (u) => {
  if (u.role !== 'admin') return '—';
  const lv = Number(u.admin_level) || 1;
  return lv >= 3 ? '根管理員' : lv === 2 ? '高階' : '管理員';
};

// 在線狀態點點（4.0.2）
const dotFor = (u) => {
  if (u.banned || u.deleted) return '<span class="status-dot st-warn" title="異常（停權或已刪除）"></span>';
  const now = Date.now();
  const la = u.last_active ? new Date(u.last_active).getTime() : 0;
  const ls = u.last_seen ? new Date(u.last_seen).getTime() : 0;
  if (la && now - la < 6 * 60000) return '<span class="status-dot st-active" title="持續活躍（6 分鐘內有操作）"></span>';
  if (ls && now - ls < 10 * 60000) return '<span class="status-dot st-online" title="在線（10 分鐘內有心跳）"></span>';
  return '<span class="status-dot st-off" title="離線"></span>';
};

const myLevelNow = () => {
  const me = getProfile() || {};
  return me.role === 'admin' ? (Number(me.admin_level) || 1) : 0;
};

// 權限旗標（沿用 4.0.2 的規則表；選單只渲染允許的項目）
function permOf(u, myLevel) {
  const lv = u.role === 'admin' ? (Number(u.admin_level) || 1) : 0;
  return {
    lv,
    dis: lv >= myLevel,                            // 層級不低於自己（含自己）就不能操作
    canGrant: myLevel >= 3 && lv < 3,               // 設/撤管理員
    canSetLevel: myLevel >= 3 && u.role === 'admin' && lv < 3, // 調層級
    canSoftDel: myLevel >= 2 && lv < myLevel,      // 軟刪除需 L2 以上
    canHardDel: myLevel >= 3 && u.deleted,          // 硬刪除僅根管理員，且針對已軟刪除帳號
  };
}

function matchUser(u) {
  if (userFilter === 'admin' && u.role !== 'admin') return false;
  if (userFilter === 'banned' && !u.banned) return false;
  if (userFilter === 'deleted' && !u.deleted) return false;
  // 「全部」沿用舊的 showDeleted 預設值語意：預設不顯示軟刪除的帳號（要看請切「已刪」）
  if (userFilter === 'all' && u.deleted) return false;
  const q = userQuery.trim().toLowerCase();
  if (!q) return true;
  return String(u.email || '').toLowerCase().includes(q) || String(u.id || '').toLowerCase().includes(q);
}

function buildUserRows(visible, myLevel) {
  return visible.map((u) => {
    const p = permOf(u, myLevel);
    const status = u.deleted ? '<span class="import-bad">已刪除</span>'
      : u.banned ? '<span class="import-bad">已停權</span>' : '正常';
    return `
      <tr data-uid="${u.id}">
        <td class="td-dot">${dotFor(u)}</td>
        <td class="td-word">
          <button class="btn-row-toggle" data-uid="${u.id}" data-expanded="0" title="展開詳情" aria-label="展開詳情">${COLLAPSED}</button>
          ${escapeHtml(u.email || '(無信箱)')}
        </td>
        <td>${levelLabel(u)}${p.lv ? ` <span class="muted small">L${p.lv}</span>` : ''}</td>
        <td>${status}</td>
        <td>${fmtDate(u.created_at)}</td>
        <td>${fmtDateTime(u.last_seen)}</td>
        <td class="td-ops">
          ${p.canHardDel ? `<button class="btn danger ud-harddel-btn" data-uid="${u.id}" data-email="${escapeHtml(u.email || '')}" title="徹底刪除（數據淨空、不可恢復）">永久刪除</button>` : ''}
          <button class="icon-btn icon-btn-sm ud-ops-btn" data-uid="${u.id}" title="帳號操作" aria-label="帳號操作" aria-haspopup="menu">${iconInline(ICONS.dots, 16, '')}</button>
        </td>
      </tr>
      <tr class="ud-detail" data-for="${u.id}" hidden><td colspan="7" class="muted">展開中…</td></tr>`;
  }).join('');
}

async function loadUsers(box) {
  if (!box) return;
  usersBox = box;
  try {
    const rows = await restFetch('profiles?select=*&order=created_at.asc');
    userRows = rows;
    renderUsers(box);
  } catch (err) {
    renderError(box, err);
  }
}

// 整區重畫（含搜尋列／篩選／表格）
function renderUsers(box) {
  const visible = userRows.filter(matchUser);
  const myLevel = myLevelNow();
  const segs = FILTERS.map(([v, label]) => `
    <label><input type="radio" name="ud-filter" value="${v}"${userFilter === v ? ' checked' : ''}><span>${label}</span></label>`).join('');

  box.replaceChildren(el(`
    <p class="muted small ud-count">共 ${userRows.length} 個帳號（顯示 ${visible.length}）。</p>
    <div class="ud-legend">
      <span><span class="status-dot st-active"></span>持續活躍（6 分內有操作）</span>
      <span><span class="status-dot st-online"></span>在線（10 分內有心跳）</span>
      <span><span class="status-dot st-warn"></span>異常（停權／已刪除）</span>
      <span><span class="status-dot st-off"></span>離線</span>
    </div>
    <div class="search-row ud-search">
      <input type="search" id="ud-search" placeholder="搜尋 Email 或帳號 ID" value="${escapeHtml(userQuery)}" autocomplete="off" spellcheck="false">
    </div>
    <div class="seg-row ud-seg">
      <span class="seg-label">篩選</span>
      <div class="segmented" role="radiogroup" aria-label="篩選使用者">${segs}</div>
    </div>
    <div class="table-scroll"><table class="ud-table">
      <thead><tr><th class="td-dot"></th><th>Email</th><th>層級</th><th>狀態</th><th>註冊</th><th>最近上線</th><th>操作</th></tr></thead>
      <tbody>${buildUserRows(visible, myLevel)}</tbody>
    </table></div>`));

  // 搜尋／篩選：只重畫 tbody，不動輸入框（否則每敲一個字就失焦）
  box.querySelector('#ud-search')?.addEventListener('input', (e) => {
    userQuery = e.target.value;
    repaintUsers(box);
  });
  box.querySelectorAll('input[name="ud-filter"]').forEach((r) => r.addEventListener('change', (e) => {
    userFilter = e.target.value;
    repaintUsers(box);
  }));

  // 列點擊：⋯ 選單／展開詳情（事件委派，repaint 後不需重新掛）
  // 【關聯註記】panel 容器在 20 秒輪詢重畫後仍是同一個節點，故委派掛一次即可，
  // 用 box.dataset 旗標防重複掛（否則點一次觸發 N 個 handler）
  if (!box.dataset.udDelegated) {
    box.dataset.udDelegated = '1';
    box.addEventListener('click', (e) => {
      const ops = e.target.closest('.ud-ops-btn');
      if (ops) { e.stopPropagation(); toggleOpsMenu(ops); return; }
      // 4.2.0：已刪列的醒目「永久刪除」直鈕（L3；與 ⋯ 選單的 harddel 同一流程）
      const hd = e.target.closest('.ud-harddel-btn');
      if (hd) {
        e.stopPropagation();
        actHardDelete(box, hd.dataset.uid, hd.dataset.email || '');
        return;
      }
      const tg = e.target.closest('.btn-row-toggle');
      if (tg) { e.stopPropagation(); toggleDetail(box, tg); return; }
      if (e.target.closest('button, select')) return;
      const tr = e.target.closest('tr[data-uid]');
      if (tr) toggleDetail(box, tr.querySelector('.btn-row-toggle'));
    });
  }
}

// 只重畫 tbody（搜尋／篩選變化）
function repaintUsers(box) {
  const myLevel = myLevelNow();
  const list = userRows.filter(matchUser);
  const body = box.querySelector('.ud-table tbody');
  if (body) body.innerHTML = buildUserRows(list, myLevel);
  const count = box.querySelector('.ud-count');
  if (count) count.textContent = `共 ${userRows.length} 個帳號（顯示 ${list.length}）。`;
}

// 展開／收合帳號詳情（點 ▾ 或整列；點操作鈕不觸發）
async function toggleDetail(box, btn) {
  const uid = btn.dataset.uid;
  const row = box.querySelector(`.ud-detail[data-for="${uid}"]`);
  if (!row) return;
  const opening = row.hidden;
  row.hidden = !opening;
  btn.dataset.expanded = opening ? '1' : '0';
  btn.innerHTML = opening ? EXPANDED : COLLAPSED;
  if (!opening) return;
  const cell = row.firstElementChild;
  cell.textContent = '載入中…';
  try {
    const d = await restFetch('rpc/admin_user_detail', {
      method: 'POST',
      body: JSON.stringify({ target_uid: uid }),
    });
    cell.replaceChildren(el(`
      <div class="ud-grid">
        <span>使用時間</span><strong>${d.usage_minutes} 分鐘／${d.usage_days} 天</strong>
        <span>複習計劃總字數</span><strong>${d.marks_total}</strong>
        <span>各階段字數</span><strong>剛開始 ${d.marks_stage0}｜近畢業 ${d.marks_graduated_estimate}</strong>
        <span>單詞本</span><strong>${d.wordbooks} 本</strong>
        <span>最後同步</span><strong>${fmtDateTime(d.last_sync) || '尚未同步'}</strong>
      </div>`));
  } catch (err) {
    cell.replaceChildren(el(`<p class="warning">詳情載入失敗：${escapeHtml(String(err.message || err))}</p>`));
  }
}

// ---------- 4.2.0：帳號操作選單（⋯）----------
// 掛在 document.body：.table-scroll 是捲動容器，選單放表格內會被裁切
// 視覺複用 .user-menu 樣式；位置（left/top）隨按鈕與視窗尺寸變動，故留行內
let openOpsMenu = null;

function closeOpsMenu() {
  if (!openOpsMenu) return;
  openOpsMenu.el.remove();
  openOpsMenu = null;
}

function opsMenuHtml(u, p) {
  const base = ` data-uid="${u.id}" data-email="${escapeHtml(u.email || '')}"`;
  const off = p.dis ? ' disabled' : '';
  const items = [
    `<button role="menuitem" data-op="ban" data-banned="${u.banned ? 1 : 0}"${base}${off}>${u.banned ? '恢復帳號' : '停權帳號'}</button>`,
  ];
  if (p.canGrant) items.push(`<button role="menuitem" data-op="role" data-role="${u.role}"${base}${off}>${u.role === 'admin' ? '撤銷管理員' : '設為管理員（L1）'}</button>`);
  if (p.canSetLevel) {
    items.push(`<button role="menuitem" data-op="level" data-lv="1"${base}${off} class="${p.lv === 1 ? 'is-current' : ''}">設為 L1 管理員</button>`);
    items.push(`<button role="menuitem" data-op="level" data-lv="2"${base}${off} class="${p.lv === 2 ? 'is-current' : ''}">設為 L2 高階</button>`);
  }
  items.push(`<button role="menuitem" data-op="pwd"${base}${off}>重置密碼</button>`);
  if (p.canSoftDel) items.push(`<button role="menuitem" data-op="del" data-deleted="${u.deleted ? 1 : 0}"${base}>${u.deleted ? '恢復帳號（解除軟刪除）' : '軟刪除帳號'}</button>`);
  if (p.canHardDel) items.push(`<button role="menuitem" data-op="harddel" class="is-danger"${base}>永久刪除</button>`);
  return items.join('');
}

function toggleOpsMenu(btn) {
  if (openOpsMenu && openOpsMenu.btn === btn) { closeOpsMenu(); return; }
  const uid = btn.dataset.uid;
  const u = userRows.find((x) => x.id === uid);
  if (!u) return;
  closeOpsMenu();

  const menu = el(`<div class="user-menu ud-menu open" role="menu">${opsMenuHtml(u, permOf(u, myLevelNow()))}</div>`);
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 190;
  const h = menu.offsetHeight || 160;
  const left = Math.min(Math.max(8, r.right - w), Math.max(8, window.innerWidth - w - 8));
  const below = r.bottom + 4;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openOpsMenu = { el: menu, btn };

  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b || b.disabled) return;
    const id = b.dataset.uid;
    const email = b.dataset.email;
    closeOpsMenu();
    const box = usersBox;
    if (b.dataset.op === 'ban') await actBan(box, id, b.dataset.banned === '1', email);
    else if (b.dataset.op === 'role') await actRole(box, id, b.dataset.role, email);
    else if (b.dataset.op === 'level') await actLevel(box, id, Number(b.dataset.lv), email);
    else if (b.dataset.op === 'pwd') await actResetPwd(box, id, email);
    else if (b.dataset.op === 'del') await actSoftDelete(box, id, b.dataset.deleted === '1', email);
    else if (b.dataset.op === 'harddel') await actHardDelete(box, id, email);
  });
}

// 點別處／捲動／Escape 收起選單（掛一次；開啟鈕以 stopPropagation 避免立刻被收掉）
document.addEventListener('click', (e) => {
  if (!openOpsMenu) return;
  if (e.target.closest('.ud-menu, .ud-ops-btn')) return;
  closeOpsMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpsMenu(); }, true);
document.addEventListener('scroll', () => closeOpsMenu(), true);

const who = (email) => email || '此帳號';
const errText = (err) => String(err?.message || err).slice(0, 160);

// 5.0.0：pending_words 欄位需先在 Supabase 執行 tools/supabase_440.sql。
// 未執行時 PostgREST 對「寫入不存在的欄位」回 400／PGRST204（部分版本回 42703），
// 偵測到就降級：不帶 pending_words 重試（待補清單不保存，功能其餘正常），
// 並在後台清單頂端提示一次（旗標記住，避免 20 秒輪詢每輪都轟）。
let pendingColumnMissing = false;   // 已偵測到欄位不存在（本 session 只提示一次）
let pendingNoticeShown = false;     // 提示已顯示過
const pendingDegradePatched = new Set(); // 降級模式下已成功 words-only PATCH 過的列 id（session 內冪等）

function isMissingPendingColumn(err) {
  const m = String(err?.message || err);
  return /PGRST204|\b42703\b/.test(m) || (/Supabase HTTP 400/.test(m) && /pending_words/.test(m));
}

const PENDING_SQL_HINT = '資料庫尚未執行 supabase_440.sql，待補清單暫不保存';

// ---------- 6000 單字一鍵佈建（5.3） ----------
// 名稱格式 `6000單字 <節>・u<N>` 是使用者端選擇器的解析依據，兩邊必須逐字一致；
// 分隔符刻意用「・」(U+30FB) 而非「/」「-」，避免與 400.sql 的 group_name 分組名混淆。
const SIXK_GROUP = '6000單字';
const SIXK_RAW_URL = 'data/questions/6000_raw.json';
const SIXK_SEP = '・';
const SIXK_BLURB = '依 data/questions/6000_raw.json 建立 38 個單元預設單詞本（每單元一列，可個別上/下架）。';
// 佈建結果（建立/跳過/失敗）跨 loadPresets 重畫保留，否則重繪後使用者看不到剛跑完的結果
let sixKResultHtml = '';

// 單元鍵 u1／u10 → 序號（排序用；不是數字就當 0，不因單一壞鍵讓整批失敗）
function unitNo(key) {
  const n = Number(String(key).replace(/^u/i, ''));
  return Number.isFinite(n) ? n : 0;
}

// 字庫外的 token（需 tools/supabase_440.sql 的 pending_words 才存得住）
// 字庫未載入時 findWord 會拋 → 視為「無法判定」，不亂標待補（寧可少記也不記錯）
function sixKOutOfBank(words) {
  try { return words.filter((t) => !findWord(t)); } catch { return []; }
}

// 把 6000_raw.json（{節:{u1:[token…]}}）攤平成「一列 = 一個單元」。純函式：不碰網路。
// existingNames 已有同名者跳過（重跑安全：不會灌出重複列），空 words 的單元略過。
function planSixKBuild(raw, existingNames = []) {
  const has = new Set((existingNames || []).map((n) => String(n)));
  const rows = [];
  for (const sec of Object.keys(raw || {})) {
    const units = Object.keys(raw[sec] || {}).sort((a, b) => unitNo(a) - unitNo(b));
    for (const u of units) {
      const words = Array.isArray(raw[sec][u]) ? raw[sec][u] : [];
      if (words.length === 0) continue;
      const name = `${SIXK_GROUP} ${sec}${SIXK_SEP}${u}`;
      if (has.has(name)) continue;
      has.add(name);
      rows.push({
        name,
        group_name: SIXK_GROUP,
        description: `第 ${unitNo(u)} 單元${SIXK_SEP}${words.length} 字`,
        words: [...words],
        pending_words: dedupeLower(sixKOutOfBank(words)),
        active: true,
        sec,          // ↓ 以下兩個欄位只給確認摘要與進度用，POST 前會被挑掉
        unit: unitNo(u),
      });
    }
  }
  return rows;
}

// 佈建流程（點按鈕才跑；fetch 只在這裡發生，離開後台不會有任何額外請求）
async function runSixKBuild(box) {
  const resultBox = box.querySelector('#pr-result');
  const say = (html) => { if (resultBox) resultBox.replaceChildren(el(html)); };
  say('<p class="muted">讀取 6000_raw.json…</p>');
  let raw;
  try {
    const res = await fetch(SIXK_RAW_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    say(`<p class="warning">讀不到 6000_raw.json：${escapeHtml(errText(err))}</p>`);
    return;
  }
  const total = planSixKBuild(raw, []).length;
  let existing = [];
  try {
    existing = await restFetch('vocab_presets?select=name');
  } catch (err) {
    say(`<p class="warning">讀取既有預設單詞本失敗：${escapeHtml(errText(err))}</p>`);
    return;
  }
  const plan = planSixKBuild(raw, (Array.isArray(existing) ? existing : []).map((r) => r.name));
  const skipped = total - plan.length;
  if (plan.length === 0) {
    sixKResultHtml = `<p class="muted">${SIXK_GROUP} 的 ${total} 個單元都已經建立過，沒有可新增的。</p>`;
    say(sixKResultHtml);
    return;
  }
  // 確認對話框：先列摘要再執行（每單元一列，名字就是使用者端選擇器要解析的字串）
  const secLines = [...plan.reduce((m, r) => m.set(r.sec, (m.get(r.sec) || []).concat(r)), new Map())]
    .map(([sec, rs]) => `<p>${escapeHtml(sec)}：${rs.length} 個單元（${escapeHtml(rs.map((r) => `u${r.unit}`).join('、'))}）</p>`)
    .join('');
  const ok = await openDialog({
    title: `${SIXK_GROUP}一鍵佈建`,
    bodyHtml: `
      <p>將建立 <strong>${plan.length}</strong> 列預設單詞本（每單元一列，共 ${total} 個單元）。${skipped ? `另有 <strong>${skipped}</strong> 列同名已存在，會跳過。` : '沒有名稱衝突。'}</p>
      ${secLines}`,
    okText: '開始佈建',
    cancelText: '取消',
  });
  if (!ok) return;

  let created = 0;
  const failed = [];
  let degraded = false;   // 是否遇到「440.sql 未執行」
  for (let i = 0; i < plan.length; i++) {
    const r = plan[i];
    // POST body 只挑規定的欄位（sec/unit 是摘要用的，不送進資料庫）
    const body = {
      name: r.name, group_name: r.group_name, description: r.description,
      words: r.words, active: true, pending_words: r.pending_words,
    };
    const postOnce = (b) => restFetch('vocab_presets', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(b),
    });
    try {
      await postOnce(body);
      created++;
    } catch (err) {
      // 欄位不存在（未執行 440.sql）→ 降級：去掉 pending_words 重試一次，佈建照常進行
      if (!isMissingPendingColumn(err)) { failed.push(`${r.name}：${errText(err)}`); }
      else {
        pendingColumnMissing = true;
        degraded = true;
        // 降級 body：只拿掉待補欄位，其餘（name/words/group_name/description/active）原封不動
        const withoutPending = { ...body };
        delete withoutPending.pending_words;
        try {
          await postOnce(withoutPending);
          created++;
        } catch (err2) { failed.push(`${r.name}：${errText(err2)}`); }
      }
    }
    say(`<p class="muted">佈建中…（${i + 1}/${plan.length}）已建立 ${created} 列</p>`);
  }
  const failHtml = failed.length
    ? `<p class="warning">失敗 ${failed.length} 列：</p><p class="muted small">${failed.map(escapeHtml).join('<br>')}</p>` : '';
  sixKResultHtml = `
    <p>已建立 <strong>${created}</strong> 列、跳過 <strong>${skipped}</strong> 列、失敗 <strong>${failed.length}</strong> 列。</p>
    ${failHtml}
    ${degraded ? `<p class="warning">${escapeHtml(PENDING_SQL_HINT)}</p>` : ''}`;
  toast(`已建立 ${created} 列${skipped ? `、跳過 ${skipped} 列` : ''}${failed.length ? `、失敗 ${failed.length} 列` : ''}`, failed.length ? 'bad' : 'ok');
  loadPresets(box);   // 重畫：清單立刻看得到新列（sixKResultHtml 會一起留在 #pr-result）
}

// 小寫化＋去重（待補清單一律小寫存；與 unknown.js 的 dedupeLower 同一規則）
function dedupeLower(list) {
  const seen = new Set();
  const out = [];
  for (const t of list || []) {
    const s = String(t ?? '').trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// 把一列的待補字分流：字庫已收錄者併入 words（去重），剩下的留在 pending_words
// 回傳 null 代表「全列無變化」（呼叫端據此決定不發 PATCH）
function planPresetFill(words, pending) {
  const rest = [];
  const add = [];
  const seenWord = new Set((Array.isArray(words) ? words : []).map((w) => String(w).toLowerCase()));
  for (const t of dedupeLower(pending)) {
    const w = findWord(t);
    if (!w) { rest.push(t); continue; }
    const key = String(w.word).toLowerCase();
    if (seenWord.has(key)) continue; // 已在 words 內 → 只需從待補清單移除
    seenWord.add(key);
    add.push(w.word);
  }
  if (add.length === 0 && (Array.isArray(pending) ? pending.length : 0) === rest.length) return null;
  return { words: [...(Array.isArray(words) ? words : []), ...add], rest, added: add.length };
}

// ---------- 使用者動作（4.2.0：confirm/alert 全換 openDialog＋toast）----------
async function rpcUser(path, body) {
  await restFetch(path, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
}

async function actBan(box, uid, banned, email) {
  const ok = await openDialog({
    title: banned ? '恢復帳號' : '停權帳號',
    body: banned
      ? `確定恢復 ${who(email)} 的登入權限？`
      : `確定停權 ${who(email)}？對方下次啟動時會被登出，並擋住後續登入。`,
    danger: !banned,
    okText: banned ? '恢復' : '停權',
    cancelText: '取消',
  });
  if (!ok) return;
  try {
    await rpcUser('rpc/set_user_banned', { target_uid: uid, new_banned: !banned });
    toast(banned ? '已恢復該帳號' : '已停權該帳號', 'ok');
    loadUsers(box);
  } catch (err) {
    toast('操作失敗：' + errText(err), 'bad');
  }
}

async function actRole(box, uid, role, email) {
  const toAdmin = role !== 'admin';
  const ok = await openDialog({
    title: toAdmin ? '設為管理員' : '撤銷管理員',
    body: toAdmin
      ? `將 ${who(email)} 設為管理員（L1）？對方即可進後台。`
      : `撤銷 ${who(email)} 的管理員身份？對方將無法再進後台。`,
    okText: toAdmin ? '設為管理員' : '撤銷',
    cancelText: '取消',
  });
  if (!ok) return;
  try {
    await rpcUser('rpc/set_user_role', { target_uid: uid, new_role: toAdmin ? 'admin' : 'user' });
    toast(toAdmin ? '已設為管理員' : '已撤銷管理員身份', 'ok');
    loadUsers(box);
  } catch (err) {
    toast('操作失敗：' + errText(err), 'bad');
  }
}

async function actLevel(box, uid, lv, email) {
  const ok = await openDialog({
    title: '調整管理員層級',
    body: `將 ${who(email)} 設為 ${lv === '2' ? 'L2 高階' : 'L1 管理員'}？`,
    okText: '調整',
    cancelText: '取消',
  });
  if (!ok) return;
  try {
    await rpcUser('rpc/set_user_level', { target_uid: uid, new_level: Number(lv) });
    toast(`已調整為 ${lv === 2 ? 'L2 高階' : 'L1 管理員'}`, 'ok');
    loadUsers(box);
  } catch (err) {
    toast('操作失敗：' + errText(err), 'bad');
  }
}

async function actResetPwd(box, uid, email) {
  const ok = await openDialog({
    title: '重置密碼',
    body: `將 ${who(email)} 的密碼重置為 00000000？對方下次登入後請自行更改。`,
    okText: '重置',
    cancelText: '取消',
  });
  if (!ok) return;
  try {
    await adminResetPassword(uid);
    toast('已重置密碼為 00000000', 'ok');
  } catch (err) {
    toast('重置失敗：' + errText(err), 'bad');
  }
}

async function actSoftDelete(box, uid, deleted, email) {
  const ok = await openDialog({
    title: deleted ? '恢復帳號' : '軟刪除帳號',
    body: deleted
      ? `確定恢復 ${who(email)}？對方可重新登入。`
      : `軟刪除 ${who(email)}？（同時停權，資料保留可恢復）`,
    danger: !deleted,
    okText: deleted ? '恢復' : '軟刪除',
    cancelText: '取消',
  });
  if (!ok) return;
  try {
    await rpcUser('rpc/set_user_deleted', { target_uid: uid, new_deleted: !deleted });
    toast(deleted ? '已恢復帳號' : '已軟刪除該帳號', 'ok');
    loadUsers(box);
  } catch (err) {
    toast('操作失敗：' + errText(err), 'bad');
  }
}

// 硬刪除：連續兩段 openDialog（danger 樣式）＋toast 回饋
// 【關聯註記】對話框掛在 document.body，不在 #admin-panel 內 → 20 秒輪詢重畫不會清掉它
async function actHardDelete(box, uid, email) {
  const step1 = await openDialog({
    title: '永久刪除',
    body: `將永久刪除 ${who(email)}。此帳號與其雲端資料將被徹底移除，無法復原。`,
    danger: true,
    okText: '繼續',
    cancelText: '取消',
  });
  if (!step1) return;
  const step2 = await openDialog({
    title: '再次確認',
    body: '此操作無法復原，確定永久刪除？',
    danger: true,
    okText: '永久刪除',
    cancelText: '再想想',
  });
  if (!step2) return;
  try {
    await adminHardDelete(uid);
    toast('已永久刪除該帳號', 'ok');
  } catch (err) {
    toast('硬刪除失敗：' + errText(err), 'bad');
    return;
  }
  loadUsers(box);
}

// 5.0.0：金鑰可設使用次數需先在 Supabase 執行 tools/supabase_450.sql。
// 未執行時 PostgREST 對「寫入不存在的欄位」回 400／PGRST204（部分版本回 42703），
// 偵測到就降級：不帶 max_uses 重試（金鑰照常建立，只是退回單次），並在金鑰清單頂端提示一次。
// 判定刻意不與 isMissingPendingColumn 共用同一段程式碼：待補欄位的降級判定已被
// smoke_pending_500 以「抽出函式原始碼單獨求值」的方式測試，抽出後不可依賴外部函式。
let keyMaxUsesMissing = false;   // 已偵測到 max_uses 欄位不存在（本 session 只在面板提示一次）
let keyNoticeShown = false;      // 面板提示已顯示過
let keyNoticeToastShown = false; // 降級 toast 已顯示過（5.0.0 池 B 驗證：降級後每次建立不應重複轟）
const MAX_USES_SQL_HINT = '資料庫尚未執行 supabase_450.sql，次數上限暫以單次建立';

function isMissingMaxUsesColumn(err) {
  const m = String(err?.message || err);
  return /PGRST204|\b42703\b/.test(m) || (/Supabase HTTP 400/.test(m) && /max_uses/.test(m));
}

// ---------- 註冊金鑰管理（3.2.0；4.0.2 複製鈕＋自定義長度放寬＋統一大寫；5.0.0 可設使用次數） ----------
// 單次金鑰＝一碼一人強綁定（現行）；5.0.0 起可設「可使用次數」：1＝原語意，>1＝可重複使用，
// 達上限自動失效（需 tools/supabase_450.sql；未執行時降級為單次，見上方 isMissingMaxUsesColumn）
// 後端 check_invite/claim_invite 以大寫比對，故所有金鑰入庫前統一轉大寫
async function loadKeys(box) {
  try {
    const rows = await restFetch('vocab_invites?select=*&order=created_at.desc');
    const list = rows.map((r) => {
      // 計數一律先轉成數字再上模板（紅線 1：清單新渲染點只放純數字，不放任何庫內字串）
      const rawCap = Number(r.max_uses);
      const rawUsed = Number(r.used_count);
      const cap = Math.max(1, Math.floor(Number.isFinite(rawCap) ? rawCap : 1));
      const used = Math.max(0, Math.floor(Number.isFinite(rawUsed) ? rawUsed : 0));
      const multi = cap > 1;
      // 「能不能用」必須與後端同一把尺：450.sql 的 check_invite／claim_invite 都是
      //   `used_count < max_uses`（supabase_450.sql 的 WHERE）。若這裡只看 used_by，會漏掉
      //   ①綁定者被管理員硬刪 → FK on delete set null，used_by 變 null 但 used_count 仍 1；
      //   ②max_uses = 0（0<0 為 false）；③max_uses 為負數（管理員繞過 UI 用 REST 直接改寫入）。
      //   這三種在後端都恆為 false，清單卻顯示可用並給複製鈕 → 學生拿到才報「金鑰無效或已用完」。
      // 欄位不存在（450.sql 未執行）時退回舊語意「used_by is null 才可用」，維持降級路徑。
      // 後端是 SQL 三值邏輯：任一邊 NULL → 比較結果非 true → 視為不可用。
      const hasCap = Number.isFinite(rawCap);
      const usable = hasCap ? (Number.isFinite(rawUsed) && rawUsed < rawCap) : !r.used_by;
      const usedAt = fmtDate(r.used_at);
      // 顯示：多次鍵看計數（used_by 只記首次使用者，顯示帳號會誤導成只有一人能註冊）；
      //   單次鍵維持現行文案。used_by 為空卻已不可用者（硬刪綁定者／max_uses 被改成 0 或負數）
      //   額外標「已用完」——否則會看起來像可以重發的死鑰。
      const looksFree = !r.used_by;                 // 舊語意下的「看起來沒被用過」
      const deadMark = !usable && looksFree ? '<span class="import-bad">（已用完）</span>' : '';
      const state = multi
        ? `已用 ${Math.min(used, cap)}／${cap}${(!usable || used >= cap) ? '<span class="import-bad">（已用完）</span>' : ''}`
        : (!usable
          ? (usedAt ? `已使用（${usedAt}）${deadMark}` : `<span class="import-bad">已用完（不可再使用）</span>`)
          : (r.used_by ? `已使用（${usedAt}）` : '<strong class="text-good">未使用</strong>'));
      // 單次鍵的複製鈕＝後端會接受的才給（避免再發一把死鑰）；多次鍵一律保留（要發給下一位），
      //   但它的「已用完／N／M」本來就寫在畫面上，不會被誤認成還能用
      const canCopy = multi || usable;
      return `
      <div class="list-row split">
        <div><code class="input-key-code">${escapeHtml(r.code)}</code>
          <span class="muted small">${state}${r.note ? '　' + escapeHtml(r.note) : ''}</span></div>
        <span>
          ${canCopy ? `<button class="btn subtle btn-key-copy" data-code="${escapeHtml(r.code)}">複製</button>` : ''}
          <button class="btn subtle btn-key-del" data-code="${escapeHtml(r.code)}">刪除</button>
        </span>
      </div>`;
    }).join('') || '<p class="muted">尚無金鑰。產生或手動添加後發給要註冊的同學。</p>';
    box.replaceChildren(el(`
      ${(keyMaxUsesMissing && !keyNoticeShown) ? `<p class="warning" id="key-sql-hint">${escapeHtml(MAX_USES_SQL_HINT)}</p>` : ''}
      <div class="controls controls-start">
        <!-- 5.0.4 F 項：主要動作鈕補 SVG 圖標。iconInline 只在 ICONS 既有 svg 上補
             class 與尺寸，不新增 path（圖庫缺合適者才會回報清單、不自繪）。 -->
        <button class="btn primary" id="btn-key-gen">${iconInline(ICONS.star, 15)}產生 16 位金鑰</button>
        <span class="search-row search-row-compact"><input type="text" id="key-manual" maxlength="40" placeholder="或自行輸入金鑰（4～40 位，不限 16）" spellcheck="false"></span>
        <button class="btn" id="btn-key-add">${iconInline(ICONS.check, 15)}添加</button>
      </div>
      <p class="muted small" id="key-note">可加備註後再產生（1＝單次金鑰；2 以上可重複使用，用完自動失效）：</p>
      <div class="import-row">
        <label>備註（選填）<input type="text" id="key-note-input" maxlength="40" placeholder="例如：三年二班 1 號"></label>
        <!-- 次數輸入：放 .import-row 內（沿用既有 label 樣式，不新增 CSS） -->
        <label>可使用次數<input type="number" id="key-max-uses" min="1" max="999" step="1" value="1" inputmode="numeric"></label>
      </div>
      <div>${list}</div>`));
    // 面板提示只出現一次：本區每 20 秒被輪詢重畫，不記住就會一直重複
    if (keyMaxUsesMissing) keyNoticeShown = true;

    // 次數輸入：兩條路徑（產生／手動添加）共用；非數字或小於 1 一律當單次
    const readMaxUses = () => {
      const v = Number(box.querySelector('#key-max-uses')?.value);
      if (!Number.isFinite(v)) return 1;
      return Math.min(999, Math.max(1, Math.floor(v)));
    };

    const addKey = async (code, note) => {
      const clean = String(code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{4,40}$/.test(clean)) { toast('金鑰需 4～40 位（字母、數字、- 或 _）', 'bad'); return; }
      const maxUses = readMaxUses();
      // 5.0.0 池 B 驗證：降級狀態記住後（keyMaxUsesMissing）直接走不帶 max_uses 的 POST——
      // 不再每次先打一次注定 400 的請求（沿用 pendingDegradePatched 的 session 冪等模式）
      const body = { code: clean, note: note || null };
      if (!keyMaxUsesMissing) body.max_uses = maxUses;
      const postOnce = () => restFetch('vocab_invites', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(body),
      });
      try {
        await postOnce();
      } catch (err) {
        // 欄位不存在（未執行 supabase_450.sql）→ 降級：去掉 max_uses 重試一次，金鑰照常建立
        if (!isMissingMaxUsesColumn(err)) {
          toast('添加失敗（可能重複）：' + String(err.message || err).slice(0, 100), 'bad');
          return;
        }
        keyMaxUsesMissing = true;
        delete body.max_uses;
        try {
          await postOnce();
        } catch (err2) {
          toast('添加失敗（可能重複）：' + String(err2.message || err2).slice(0, 100), 'bad');
          return;
        }
        // 降級提示只出一次（5.0.0 池 B 驗證：每次建立都轟一次紅色 toast 是干擾）
        if (!keyNoticeToastShown) { toast(MAX_USES_SQL_HINT, 'bad'); keyNoticeToastShown = true; }
        loadKeys(box);
        return;
      }
      toast(maxUses > 1 ? `已添加金鑰 ${clean}（可使用 ${maxUses} 次）` : `已添加金鑰 ${clean}`, 'ok');
      loadKeys(box);
    };

    box.querySelector('#btn-key-gen').addEventListener('click', () => {
      addKey(generateInviteKey(), box.querySelector('#key-note-input').value.trim());
    });
    box.querySelector('#btn-key-add').addEventListener('click', () => {
      addKey(box.querySelector('#key-manual').value, box.querySelector('#key-note-input').value.trim());
    });
    box.querySelectorAll('.btn-key-copy').forEach((b) => b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.code);
        b.textContent = '已複製';
        setTimeout(() => { b.textContent = '複製'; }, 1200);
      } catch {
        toast('複製失敗（瀏覽器不允許）：請手動選取金鑰複製', 'bad');
      }
    }));
    box.querySelectorAll('.btn-key-del').forEach((b) => b.addEventListener('click', async () => {
      const code = b.dataset.code;
      const ok = await openDialog({
        title: '刪除金鑰',
        body: `刪除金鑰 ${code}？（已綁定的帳號不受影響）`,
        danger: true,
        okText: '刪除',
        cancelText: '取消',
      });
      if (!ok) return;
      try {
        await restFetch(`vocab_invites?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
        toast('已刪除金鑰', 'ok');
        loadKeys(box);
      } catch (err) {
        toast('刪除失敗：' + errText(err), 'bad');
      }
    }));
  } catch (err) {
    renderError(box, err);
  }
}

// ---------- 公告系統 ----------
async function loadAnnouncements(box) {
  try {
    const rows = await restFetch('vocab_announcements?select=*&order=id.desc');
    const list = rows.map((r) => `
      <div class="list-row split">
        <div><span class="status-dot ${r.active ? 'st-online' : 'st-off'}" title="${r.active ? '上架中' : '已下架'}"></span>${escapeHtml(r.content)}
          <span class="muted small">　${fmtDate(r.created_at)}</span></div>
        <span>
          <button class="btn subtle btn-ann-toggle" data-id="${r.id}" data-active="${r.active ? 1 : 0}">${r.active ? '下架' : '上架'}</button>
          <button class="btn subtle btn-ann-del" data-id="${r.id}">刪除</button>
        </span>
      </div>`).join('') || '<p class="muted">目前沒有公告。</p>';
    box.replaceChildren(el(`
      <div class="import-row"><label>公告內容 <input type="text" id="ann-text" maxlength="120" placeholder="例如：4.0 版已上線，記得更新"></label>
        <button class="btn primary align-end" id="btn-ann-add">${iconInline(ICONS.volume, 15)}發佈</button></div>
      <div id="ann-list">${list}</div>`));

    box.querySelector('#btn-ann-add').addEventListener('click', async () => {
      const text = box.querySelector('#ann-text').value.trim();
      if (!text) return;
      try {
        await restFetch('vocab_announcements', { method: 'POST', body: JSON.stringify({ content: text }) });
        toast('已發佈公告', 'ok');
        loadAnnouncements(box);
      } catch (err) {
        toast('發佈失敗：' + errText(err), 'bad');
      }
    });
    box.querySelectorAll('.btn-ann-toggle').forEach((b) => b.addEventListener('click', async () => {
      const next = b.dataset.active !== '1';
      await restFetch(`vocab_announcements?id=eq.${b.dataset.id}`, {
        method: 'PATCH', body: JSON.stringify({ active: next }),
      });
      toast(next ? '已上架' : '已下架', 'ok');
      loadAnnouncements(box);
    }));
    box.querySelectorAll('.btn-ann-del').forEach((b) => b.addEventListener('click', async () => {
      const ok = await openDialog({
        title: '刪除公告',
        body: '刪除這則公告？',
        danger: true,
        okText: '刪除',
        cancelText: '取消',
      });
      if (!ok) return;
      try {
        await restFetch(`vocab_announcements?id=eq.${b.dataset.id}`, { method: 'DELETE' });
        toast('已刪除公告', 'ok');
        loadAnnouncements(box);
      } catch (err) {
        toast('刪除失敗：' + errText(err), 'bad');
      }
    }));
  } catch (err) {
    renderError(box, err);
  }
}

// ---------- 預設單詞本發佈（4.0.2：支援分組；括號形式單字已由 parseWordTokens 支援） ----------
// 5.0.0：字庫外單字記進 pending_words（需 supabase_440.sql）；字庫收錄後本函式自動補進並 PATCH
async function loadPresets(box) {
  try {
    const rows = await restFetch('vocab_presets?select=*&order=id.desc');
    // 5.0.0：自動補進（等同每次進後台 presets 分區都自癒）。字庫未載入時 getWords 會拋，
    //   沿用既有的「該區在驗證時提示」降級，不讓自動補進把整區拖垮。
    let filledTotal = 0;
    const filledNames = [];
    for (const r of rows) {
      if (!(Array.isArray(r.pending_words) && r.pending_words.length)) continue;
      let plan = null;
      try { plan = planPresetFill(r.words, r.pending_words); } catch { break; } // 字庫未載入 → 停止掃描
      if (!plan) continue; // 全列無變化 → 不發 PATCH
      const before = Array.isArray(r.words) ? r.words.length : 0;
      try {
        await restFetch(`vocab_presets?id=eq.${r.id}`, {
          method: 'PATCH', body: JSON.stringify({ words: plan.words, pending_words: plan.rest }),
        });
      } catch (err) {
        // 欄位不存在（未執行 440.sql）→ 降級：只 PATCH words，待補清單保留原樣
        if (!isMissingPendingColumn(err)) { console.warn('待補自動補進失敗：', errText(err)); continue; }
        pendingColumnMissing = true;
        // 冪等（5.0.0 池 B 驗證）：降級模式下 words-only PATCH 已成功過的列不再重打——
        // 雲端 pending_words 清不掉（欄位不存在），不記住的話每 20 秒輪詢都會重打一次必然 400＋一次 204
        if (pendingDegradePatched.has(r.id)) { r.words = plan.words; continue; }
        try {
          await restFetch(`vocab_presets?id=eq.${r.id}`, {
            method: 'PATCH', body: JSON.stringify({ words: plan.words }),
          });
        } catch (e2) { console.warn('待補自動補進失敗：', errText(e2)); continue; }
        // 降級路徑：words 已補上，但待補清單沒清掉 → 不重複 toast（下次進本區會再試）
        pendingDegradePatched.add(r.id);
        r.words = plan.words;
        continue;
      }
      r.words = plan.words;
      r.pending_words = plan.rest;
      filledTotal += plan.words.length - before;
      filledNames.push(r.name);
    }
    if (filledTotal > 0) toast(`字庫已收錄待補單字 ${filledTotal} 個，已自動補進單詞本（${filledNames.join('、')}）`, 'ok');
    const list = rows.map((r) => {
      const words = Array.isArray(r.words) ? r.words : [];
      const pending = Array.isArray(r.pending_words) ? r.pending_words : [];
      return `
      <div class="list-row split">
        <div><strong>${escapeHtml(r.name)}</strong>${r.group_name ? `<span class="grp-tag">${escapeHtml(r.group_name)}</span>` : ''}<span class="muted small">　${words.length} 字${r.description ? '　' + escapeHtml(r.description) : ''}</span>
          ${r.active ? '' : '<span class="import-bad">（已下架）</span>'}
          ${pending.length ? `<div class="muted small">待補 ${pending.length}：${escapeHtml(pending.slice(0, 6).join('、'))}${pending.length > 6 ? '…' : ''}（字庫補上後自動加入）</div>` : ''}</div>
        <span>
          <button class="btn subtle btn-pr-toggle" data-id="${r.id}" data-active="${r.active ? 1 : 0}">${r.active ? '下架' : '上架'}</button>
          <button class="btn subtle btn-pr-del" data-id="${r.id}">刪除</button>
        </span>
      </div>`;
    }).join('') || '<p class="muted">目前沒有已發佈的預設單詞本。</p>';
    box.replaceChildren(el(`
      <div class="import-panel">
        ${(pendingColumnMissing && !pendingNoticeShown) ? `<p class="warning" id="pr-sql-hint">${escapeHtml(PENDING_SQL_HINT)}</p>` : ''}
        <div class="import-row">
          <label>名稱 <input type="text" id="pr-name" maxlength="30"></label>
          <label>分組（選填） <input type="text" id="pr-group" maxlength="20" placeholder="例如：113學測高頻"></label>
          <label>說明（選填） <input type="text" id="pr-desc" maxlength="60"></label>
        </div>
        <textarea id="pr-words" rows="4" placeholder="貼上單字（空格／換行分隔；支援 word(變化1, 變化2) 括號形式），發佈前會先驗證" spellcheck="false"></textarea>
        <div class="controls controls-start">
          <!-- 5.0.4 F 項：主要動作鈕補 SVG 圖標（沿用 ICONS，不自繪） -->
          <button class="btn primary" id="btn-pr-add">${iconInline(ICONS.checkCircle, 15)}驗證並發佈</button>
          <button class="btn" id="btn-pr-6000">${iconInline(ICONS.download, 15)}6000 單字一鍵佈建</button>
        </div>
        <p class="muted small">${escapeHtml(SIXK_BLURB)}</p>
        <div id="pr-result">${sixKResultHtml}</div>
      </div>
      <div>${list}</div>`));
    // 降級提示只出現一次：本區每 20 秒被輪詢重畫，不記住就會一直重複
    if (pendingColumnMissing) pendingNoticeShown = true;

    box.querySelector('#btn-pr-6000').addEventListener('click', () => { runSixKBuild(box); });

    box.querySelector('#btn-pr-add').addEventListener('click', () => {
      const name = box.querySelector('#pr-name').value.trim();
      const group = box.querySelector('#pr-group').value.trim();
      const desc = box.querySelector('#pr-desc').value.trim();
      const tokens = parseWordTokens(box.querySelector('#pr-words').value);
      const resultBox = box.querySelector('#pr-result');

      if (!name) { resultBox.replaceChildren(el('<p class="warning">請輸入名稱</p>')); return; }
      try { getWords(); } catch { resultBox.replaceChildren(el('<p class="warning">字庫未載入，無法驗證單字；請按右上的刷新鈕重試。</p>')); return; } // 4.1.0（4.2.0 批次 2：⟳ 字元改文字）
      const { valid, invalid } = verifyTokens(tokens);
      if (valid.length === 0) {
        resultBox.replaceChildren(el(`<p class="warning">沒有可發佈的字（字庫外：${escapeHtml(invalid.join('、')) || '無輸入'}）</p>`));
        return;
      }
      const invalidNote = invalid.length ? `<p class="warning">字庫外已略過並記錄待補 ${invalid.length} 個：${escapeHtml(invalid.join('、'))}（字庫補上後會自動加入單詞本）</p>` : '';
      resultBox.replaceChildren(el(`
        ${invalidNote}
        <p>將發佈「${escapeHtml(name)}」${group ? `（分組：${escapeHtml(group)}）` : ''}：<strong>${valid.length}</strong> 字
           （${valid.slice(0, 6).map((w) => escapeHtml(w.word)).join('、')}${valid.length > 6 ? '…' : ''}）</p>
        <!-- 5.0.4 F 項：確認對話框的主動作鈕也是「主要動作鈕」，同樣補圖標（沿用 ICONS） -->
        <button class="btn primary" id="btn-pr-confirm">${iconInline(ICONS.checkCircle, 15)}確認發佈</button>`));
      resultBox.querySelector('#btn-pr-confirm').addEventListener('click', async () => {
        // 5.0.0：字庫外單字隨發佈一併記進 pending_words（需 supabase_440.sql）
        const pending = dedupeLower(invalid);
        const body = {
          name, description: desc || null, group_name: group || '',
          words: valid.map((w) => w.word), active: true, pending_words: pending,
        };
        const postOnce = () => restFetch('vocab_presets', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(body),
        });
        try {
          await postOnce();
        } catch (err) {
          // 欄位不存在（未執行 440.sql）→ 降級：去掉 pending_words 重試一次，發佈照常成功
          if (!isMissingPendingColumn(err)) {
            resultBox.replaceChildren(el(`<p class="warning">發佈失敗：${escapeHtml(String(err.message || err))}</p>`));
            return;
          }
          pendingColumnMissing = true;
          try {
            delete body.pending_words;
            await postOnce();
          } catch (err2) {
            resultBox.replaceChildren(el(`<p class="warning">發佈失敗：${escapeHtml(String(err2.message || err2))}</p>`));
            return;
          }
          if (pending.length) toast(`已發佈「${name}」；${PENDING_SQL_HINT}`, 'bad');
        }
        toast(`已發佈「${name}」（${valid.length} 字）${pending.length && !pendingColumnMissing ? `，略過 ${pending.length} 個已記錄待補` : ''}`, 'ok');
        loadPresets(box);
      });
    });
    box.querySelectorAll('.btn-pr-toggle').forEach((b) => b.addEventListener('click', async () => {
      const next = b.dataset.active !== '1';
      await restFetch(`vocab_presets?id=eq.${b.dataset.id}`, {
        method: 'PATCH', body: JSON.stringify({ active: next }),
      });
      toast(next ? '已上架' : '已下架', 'ok');
      loadPresets(box);
    }));
    box.querySelectorAll('.btn-pr-del').forEach((b) => b.addEventListener('click', async () => {
      const ok = await openDialog({
        title: '刪除預設單詞本',
        body: '刪除這本預設單詞本？使用者的資料不受影響，但無法再匯入。',
        danger: true,
        okText: '刪除',
        cancelText: '取消',
      });
      if (!ok) return;
      try {
        await restFetch(`vocab_presets?id=eq.${b.dataset.id}`, { method: 'DELETE' });
        toast('已刪除該單詞本', 'ok');
        loadPresets(box);
      } catch (err) {
        toast('刪除失敗：' + errText(err), 'bad');
      }
    }));
  } catch (err) {
    renderError(box, err);
  }
}

// ---------- 統計圖表（3.3.1／T-014：14 天折線圖，純 SVG 零依賴） ----------
// 兩條折線共用同一個 y 軸刻度但各自的最大值：活躍人數與使用分鐘數量級不同，
// 各自取 max 才有起伏可看（否則分鐘數會把活躍數壓成貼地直線）
const CHART = { w: 560, h: 200, padL: 30, padR: 30, padT: 12, padB: 26 };

// max 向上取整到「好讀的刻度」：1/2/5 × 10^n
function niceMax(v) {
  const n = Math.max(1, Number(v) || 0);
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  for (const step of [1, 2, 2.5, 5, 10]) {
    const cand = step * base;
    if (cand >= n) return cand;
  }
  return 10 * base;
}

// 產出 14 天折線圖 SVG 字串
function buildLineChart(labels, series) {
  const innerW = CHART.w - CHART.padL - CHART.padR;
  const innerH = CHART.h - CHART.padT - CHART.padB;
  const n = labels.length;
  const x = (i) => CHART.padL + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));

  let marks = '';
  let yAxis = '';
  let xLabels = '';

  series.forEach((s) => {
    const max = niceMax(Math.max(...s.values, 0));
    const y = (v) => CHART.padT + innerH - (v / max) * innerH;
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

    // y 軸刻度線＋文字（0 / max）
    yAxis += `
      <line x1="${CHART.padL}" y1="${y(0).toFixed(1)}" x2="${CHART.w - CHART.padR}" y2="${y(0).toFixed(1)}"
            stroke="var(--border)" stroke-width="1"/>
      <line x1="${CHART.padL}" y1="${y(max).toFixed(1)}" x2="${CHART.w - CHART.padR}" y2="${y(max).toFixed(1)}"
            stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${CHART.padL - 6}" y="${(y(max) + 4).toFixed(1)}" text-anchor="end"
            font-size="10" fill="var(--muted)">${max}</text>
      <text x="${CHART.padL - 6}" y="${(y(0) + 4).toFixed(1)}" text-anchor="end"
            font-size="10" fill="var(--muted)">0</text>`;

    marks += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5"
                stroke-linejoin="round" stroke-linecap="round"/>`;
    s.values.forEach((v, i) => {
      marks += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${s.color}">
        <title>${labels[i]}　${s.name}：${v}</title>
      </circle>`;
    });
  });

  // x 軸標籤：每 2 天顯示一次
  labels.forEach((lab, i) => {
    if (i % 2 !== 0 && i !== n - 1) return;
    xLabels += `<text x="${x(i).toFixed(1)}" y="${CHART.h - 8}" text-anchor="middle"
                  font-size="10" fill="var(--muted)">${lab}</text>`;
  });

  return `<svg class="line-chart" viewBox="0 0 ${CHART.w} ${CHART.h}" role="img"
               aria-label="近 14 天活躍人數與使用分鐘數折線圖">
    ${yAxis}${marks}${xLabels}
  </svg>`;
}

async function loadUsage(box) {
  if (!box) return;
  try {
    const [usage, profiles] = await Promise.all([
      restFetch('vocab_usage?select=user_id,day,minutes&order=day.desc&limit=2000'),
      restFetch('profiles?select=id,created_at,last_seen'),
    ]);

    // 每日活躍人數（去重 user_id）與每日使用分鐘數（加總 minutes）
    const activePerDay = new Map();
    const minsPerDay = new Map();
    for (const u of usage) {
      if (!activePerDay.has(u.day)) activePerDay.set(u.day, new Set());
      activePerDay.get(u.day).add(u.user_id);
      minsPerDay.set(u.day, (minsPerDay.get(u.day) || 0) + (Number(u.minutes) || 0));
    }

    const DAY = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const labels = [];
    const activeArr = [];
    const minsArr = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getTime() - i * DAY);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      labels.push(key.slice(5).replace('-', '/'));
      activeArr.push((activePerDay.get(key)?.size) || 0);
      minsArr.push(minsPerDay.get(key) || 0);
    }

    const activeWeek = profiles.filter((p) => p.last_seen && Date.now() - new Date(p.last_seen).getTime() < 7 * DAY).length;
    const activeToday = activeArr[activeArr.length - 1];
    const svg = buildLineChart(labels, [
      { name: '活躍人數', color: 'var(--accent)', values: activeArr },
      { name: '使用分鐘', color: 'var(--warn)', values: minsArr },
    ]);

    box.replaceChildren(el(`
      <div class="srs-summary">
        <div class="srs-box"><div class="num">${profiles.length}</div><div class="label">總帳號</div></div>
        <div class="srs-box"><div class="num">${activeWeek}</div><div class="label">近 7 天活躍</div></div>
        <div class="srs-box"><div class="num">${activeToday}</div><div class="label">今日活躍</div></div>
      </div>
      <div class="chart-legend">
        <span class="lg lg-accent"><span class="lg-dot"></span>活躍人數</span>
        <span class="lg lg-warn"><span class="lg-dot"></span>使用分鐘</span>
        <span class="muted small">滑過任一點看當日數值</span>
      </div>
      ${svg}
      <p class="muted small">兩條線各自獨立刻度（量級不同，不共用同一把尺）。</p>`));
  } catch (err) {
    renderError(box, err);
  }
}

// ---------- 系統狀態（3.3.0；4.0.2 新增平台額度：DB／Storage／帳號／Edge Function） ----------
const QUOTA_BYTES = 500 * 1024 * 1024;        // Supabase 免費額度：資料庫 500MB
const QUOTA_STORAGE = 1024 * 1024 * 1024;     // Supabase 免費額度：Storage 1GB

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 5.1.9：fmtTime 已移到檔頭與 fmtDate／fmtDateTime 放在一起（全檔共用一組時區格式化），
// 這裡原本的定義已刪除，避免同名重複宣告。

async function loadSys(box) {
  if (!box) return;
  try {
    const raw = await restFetch('rpc/admin_live_stats', { method: 'POST', body: JSON.stringify({}) });
    if (!raw || typeof raw !== 'object') throw new Error('無法取得系統統計');
    // 正式 RPC 使用 active_now／backups／edge_function_calls；缺少的統計不可冒充為零。
    const s = {
      ...raw,
      online: raw.online ?? raw.active_now ?? '—',
      backups_count: raw.backups_count ?? raw.backups ?? '—',
      fn_calls: raw.fn_calls ?? raw.edge_function_calls ?? '—',
      minutes_today: raw.minutes_today ?? '—',
    };
    const pct = Math.min(100, Math.round((Number(s.db_bytes) || 0) / QUOTA_BYTES * 100));

    // 平台額度（4.0.2；需執行 supabase_400.sql，未執行時優雅降級）
    let plat = null;
    try {
      plat = await restFetch('rpc/admin_platform_stats', { method: 'POST', body: JSON.stringify({}) });
    } catch { /* 遷移未執行：顯示提示 */ }
    const dbPct = plat ? Math.min(100, Math.round((Number(plat.db_size) || 0) / QUOTA_BYTES * 100)) : 0;
    const stPct = plat ? Math.min(100, Math.round((Number(plat.storage_bytes) || 0) / QUOTA_STORAGE * 100)) : 0;

    box.replaceChildren(el(`
      <p class="sys-fn">Edge Function：近 24 小時呼叫 <strong>${s.fn_calls}</strong> 次｜最後呼叫 ${fmtTime(s.fn_last)}</p>
      <div class="srs-summary">
        <div class="srs-box"><div class="num">${s.total_users}</div><div class="label">總帳號</div></div>
        <div class="srs-box"><div class="num">${s.active_today}</div><div class="label">今日活躍</div></div>
        <div class="srs-box"><div class="num">${s.online}</div><div class="label">目前線上</div></div>
      </div>
      <p>今日使用時間 <strong>${s.minutes_today}</strong> 分鐘｜雲端備份 <strong>${s.backups_count}</strong> 份</p>
      <p>應用資料表存儲量 <strong>${s.db_bytes == null ? '—' : formatBytes(s.db_bytes)}</strong>
        <span class="muted small">（含索引估計；免費額度 500MB）</span></p>
      <div class="stat-bar"><span style="width:${pct}%"></span></div>
      <p class="muted small">在線＝10 分鐘內有心跳；使用時間只計「有操作」的時間，開著不動不灌水。</p>
      ${plat ? `
        <h3 class="section-title-lg">平台額度（Supabase 免費方案）</h3>
        <div class="quota-rows">
          <div class="q-row"><span class="q-label">整個資料庫</span>
            <span class="stat-bar"><span style="width:${dbPct}%"></span></span>
            <span class="q-val">${formatBytes(plat.db_size)} / 500 MB</span></div>
          <div class="q-row"><span class="q-label">檔案 Storage</span>
            <span class="stat-bar"><span style="width:${stPct}%"></span></span>
            <span class="q-val">${formatBytes(plat.storage_bytes)} / 1 GB</span></div>
          <div class="q-row"><span class="q-label">帳號規模</span>
            <span></span>
            <span class="q-val">有效 ${plat.users_active}／總數 ${plat.users_total}｜30 天月活躍 ${plat.mau_30}</span></div>
          <div class="q-row"><span class="q-label">Edge Function</span>
            <span></span>
            <span class="q-val">30 天呼叫 ${plat.fn_calls_30d} 次</span></div>
        </div>
        <p class="muted small note-tight">整個資料庫含系統與所有資料表；月活躍＝30 天內有使用紀錄的帳號數。</p>
      ` : `
        <p class="muted small note-head">※ 平台額度統計需先在 Supabase SQL Editor 執行 tools/supabase_400.sql。</p>
      `}`));
  } catch (err) {
    renderError(box, err);
  }
}

// ---------- 反饋管理（4.1.0）：工單列表＋回復 ----------
// 【關聯註記】輪詢保護：startLiveRefresh 只輪當前區；本區由 SECTIONS.editing
// 標記走 refreshUnlessEditing，使用者正在打的回覆文字不會被 20 秒輪詢吃掉
async function loadFeedback(box) {
  if (!box) return;
  try {
    const [rows, profiles] = await Promise.all([
      restFetch('vocab_feedback?select=*&order=created_at.desc&limit=100'),
      restFetch('profiles?select=id,email'),
    ]);
    const emailOf = new Map(profiles.map((p) => [p.id, p.email]));
    const list = rows.map((r) => `
      <div class="list-row fb-admin" data-id="${r.id}">
        <div class="fb-q">${escapeHtml(r.content)}
          <span class="muted small">${escapeHtml(emailOf.get(r.user_id) || r.user_id.slice(0, 8))}｜${fmtDateTime(r.created_at)}</span></div>
        ${r.reply
          ? `<div class="fb-a">${escapeHtml(r.reply)}
               <button class="btn subtle btn-fb-edit" data-id="${r.id}" data-reply="${escapeHtml(r.reply)}">${iconInline(ICONS.chevronRight, 14)}修改</button></div>`
          : `<div class="fb-reply-row">
               <input type="text" class="fb-reply-input" data-id="${r.id}" maxlength="500" placeholder="回復這張工單…">
               <!-- 5.0.4 F 項：主要動作鈕（送出回覆）補圖標 -->
               <button class="btn primary btn-fb-send" data-id="${r.id}">${iconInline(ICONS.arrowUpRight, 15)}回復</button>
             </div>`}
      </div>`).join('') || '<p class="muted">目前沒有反饋工單。</p>';
    box.replaceChildren(el(`<div>${list}</div>`));

    const sendReply = async (id, text, btn) => {
      if (!text || !text.trim()) { toast('回復內容不可為空', 'bad'); return; }
      if (btn) btn.disabled = true;
      try {
        await restFetch(`vocab_feedback?id=eq.${id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ reply: text.trim(), replied_at: new Date().toISOString() }),
        });
        toast('已送出回覆', 'ok');
        loadFeedback(box);
      } catch (err) {
        toast('回復失敗：' + String(err.message || err).slice(0, 140), 'bad');
        if (btn) btn.disabled = false;
      }
    };
    box.querySelectorAll('.btn-fb-send').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.id;
      sendReply(id, box.querySelector(`.fb-reply-input[data-id="${id}"]`).value, b);
    }));
    box.querySelectorAll('.btn-fb-edit').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      // 4.2.0：原生輸入框換 openDialog 的 input 模式（回傳 string｜null）
      const text = await openDialog({
        title: '修改回復內容',
        body: '修改後對方在自己的反饋面板會看到新內容。',
        input: true,
        value: b.dataset.reply,
        placeholder: '輸入要顯示給使用者的文字',
      });
      if (text === null) return;
      sendReply(id, text, null);
    }));
  } catch (err) {
    renderError(box, err);
  }
}

function renderError(box, err) {
  box.replaceChildren(el(`<p class="warning">載入失敗：${escapeHtml(String(err.message || err))}</p>`));
}

// ============================================================
// 6.3.0 Pro 管理（admin-site 後台）
// 功能：建立啟用碼（永久／限期；明碼只在建立成功時回一次，請立即複製）、
//       啟用碼清單＋作廢、撤銷使用者 Pro、授予清單查詢。
// 所有動作走 pro-api Edge（pro-api.js transport）：後端 SQL（pro-630.sql）＋
// Edge 部署完成後即可用；未部署時此區顯示「後端未就緒」誠實錯誤。
// ============================================================
async function loadPro(box) {
  if (!box) return;
  const generation = getAuthGeneration();
  // 在途查詢或操作不能在登出、換帳戶或切分區後重新顯示敏感資料／明碼。
  const current = () => box.isConnected && generation === getAuthGeneration()
    && location.hash.replace(/^#\/?/, '').split('?')[0] === 'admin'
    && currentSec() === 'pro';
  if (!current()) return;
  try {
    const codes = await proAdminListCodes();
    if (!current()) return;
    const codeRows = (codes || []).map((c) => {
      const kindText = c.kind === 'permanent' ? '永久' : `限期 ${c.days ?? '?'} 天`;
      const statusText = c.status === 'available' ? '<strong class="text-good">可用</strong>'
        : c.status === 'redeemed' ? `<span class="import-bad">已兌換</span>`
        : '<span class="import-bad">已作廢</span>';
      const redeemed = c.redeemedAt || c.redeemed_at ? fmtDateTime(c.redeemedAt || c.redeemed_at) : '—';
      return `
        <div class="list-row pro-code" data-id="${c.id}">
          <div class="pro-code-main">
            <strong>${kindText}</strong>
            <span class="muted small">建立 ${fmtDateTime(c.createdAt || c.created_at)}</span>
            <span class="muted small">兌換 ${redeemed}</span>
          </div>
          <span class="pro-code-status">${statusText}</span>
          ${c.status === 'available' ? `<button class="btn subtle btn-pro-void" data-id="${c.id}">${iconInline(ICONS.cross, 14)}作廢</button>` : ''}
        </div>`;
    }).join('') || '<p class="muted">尚未建立任何 Pro 啟用碼。</p>';

    box.replaceChildren(el(`
      <div class="pro-admin">
        <h3 class="pro-sec-title">建立啟用碼</h3>
        <div class="import-row pro-create-row">
          <label>類型
            <select id="pro-kind" class="input-shared">
              <option value="permanent">永久</option>
              <option value="limited_term">限期（天）</option>
            </select>
          </label>
          <label>天數（限期時）
            <input type="number" id="pro-days" min="1" step="1" value="30" inputmode="numeric" class="input-shared">
          </label>
          <button class="btn primary" id="btn-pro-create">${iconInline(ICONS.star, 15)}建立啟用碼</button>
        </div>
        <p class="muted small" id="pro-create-note">明碼只在建立成功時顯示一次，請立即複製給使用者兌換。</p>

        <h3 class="pro-sec-title">啟用碼清單</h3>
        <div>${codeRows}</div>

        <h3 class="pro-sec-title">撤銷 Pro</h3>
        <div class="import-row pro-revoke-row">
          <label>帳號 UID
            <input type="text" id="pro-revoke-uid" class="input-shared" placeholder="目標使用者的 uuid" spellcheck="false">
          </label>
          <label>原因
            <input type="text" id="pro-revoke-reason" class="input-shared" maxlength="200" placeholder="撤銷原因（必填）">
          </label>
          <button class="btn" id="btn-pro-revoke">${iconInline(ICONS.cross, 15)}撤銷 Pro</button>
        </div>

        <h3 class="pro-sec-title">授予清單</h3>
        <div class="import-row">
          <label>帳號 UID（留空＝全部）
            <input type="text" id="pro-grant-uid" class="input-shared" placeholder="選填，只查某一帳號" spellcheck="false">
          </label>
          <button class="btn" id="btn-pro-grants">${iconInline(ICONS.chevronRight, 15)}查詢</button>
        </div>
        <div id="pro-grant-result"></div>
      </div>`));

    // 建立啟用碼
    box.querySelector('#btn-pro-create').addEventListener('click', async () => {
      const kind = box.querySelector('#pro-kind').value;
      const days = kind === 'limited_term' ? Number(box.querySelector('#pro-days').value) : null;
      if (kind === 'limited_term' && (!Number.isInteger(days) || days <= 0)) {
        toast('限期碼天數必須是正整數', 'bad'); return;
      }
      const btn = box.querySelector('#btn-pro-create');
      btn.disabled = true;
      try {
        const res = await proAdminCreateCode(kind, days);
        if (!current()) return;
        // 明碼只在成功時回一次；用 dialog 顯示＋複製（關閉即消失，不留畫面）
        const code = res && res.code;
        if (!code) { toast('建立成功但未收到明碼（異常）', 'bad'); loadPro(box); return; }
        await openDialog({
          title: 'Pro 啟用碼已建立（明碼只顯示一次）',
          body: `請立即複製並發給使用者：<br><strong style="font-size:1.2rem;letter-spacing:2px;user-select:all">${escapeHtml(code)}</strong>`,
          okText: '我已經複製好了',
          cancelText: '關閉',
        });
        if (!current()) return;
        toast(`已建立${kind === 'permanent' ? '永久' : `限期 ${days} 天`}啟用碼`, 'ok');
        loadPro(box);
      } catch (err) {
        // 後端未就緒（SQL／Edge 未部署）時誠實顯示
        if (current()) toast('建立失敗：' + String(err.message || err).slice(0, 180), 'bad');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // 作廢啟用碼
    box.querySelectorAll('.btn-pro-void').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const ok = await openDialog({
        title: '作廢啟用碼',
        body: '作廢後此碼無法再兌換；已兌換的 Pro 不受影響。',
        danger: true,
        okText: '作廢',
        cancelText: '取消',
      });
      if (!ok || !current()) return;
      try {
        await proAdminVoidCode(id);
        if (!current()) return;
        toast('已作廢', 'ok');
        loadPro(box);
      } catch (err) {
        if (current()) toast('作廢失敗：' + String(err.message || err).slice(0, 140), 'bad');
      }
    }));

    // 撤銷 Pro
    box.querySelector('#btn-pro-revoke').addEventListener('click', async () => {
      const uid = box.querySelector('#pro-revoke-uid').value.trim();
      const reason = box.querySelector('#pro-revoke-reason').value.trim();
      if (!uid) { toast('請填目標帳號 UID', 'bad'); return; }
      if (!reason) { toast('請填撤銷原因', 'bad'); return; }
      const ok = await openDialog({
        title: '撤銷 Pro',
        body: `確定撤銷帳號 ${escapeHtml(uid)} 的 Pro？原因：${escapeHtml(reason)}`,
        danger: true,
        okText: '撤銷',
        cancelText: '取消',
      });
      if (!ok || !current()) return;
      try {
        const res = await proAdminRevokePro(uid, reason);
        if (!current()) return;
        toast(`已撤銷（${res?.revokedGrants ?? 0} 筆授予）`, 'ok');
      } catch (err) {
        if (current()) toast('撤銷失敗：' + String(err.message || err).slice(0, 140), 'bad');
      }
    });

    // 授予清單查詢
    box.querySelector('#btn-pro-grants').addEventListener('click', async () => {
      const uid = box.querySelector('#pro-grant-uid').value.trim() || null;
      const host = box.querySelector('#pro-grant-result');
      host.replaceChildren(el('<p class="muted">查詢中…</p>'));
      try {
        const grants = await proAdminListGrants(uid);
        if (!current()) return;
        const rows = (grants || []).map((g) => `
          <div class="list-row pro-grant">
            <span class="muted small">${escapeHtml(String(g.userId || g.user_id || '?'))}</span>
            <span>${g.kind === 'permanent' ? '永久' : '限期'}</span>
            <span class="muted small">${fmtDateTime(g.createdAt || g.created_at)}</span>
            <span>${g.status === 'revoked' ? '已撤銷' : g.status !== 'active' ? '尚未確認' : g.kind === 'permanent' ? '有效' : !Number.isFinite(Date.parse(g.expiresAt)) ? '尚未確認' : Date.parse(g.expiresAt) <= Date.now() ? '已到期' : '有效'}</span>
          </div>`).join('') || '<p class="muted">沒有授予記錄。</p>';
        host.replaceChildren(el(`<div>${rows}</div>`));
      } catch (err) {
        if (!current()) return;
        host.replaceChildren(el(`<p class="warning">查詢失敗：${escapeHtml(String(err.message || err))}</p>`));
      }
    });
  } catch (err) {
    // 列表載入失敗（含後端未部署）→ 顯示錯誤＋「可重試」；UI 仍可試建立動作（會誠實報錯）
    if (!current()) return;
    box.replaceChildren(el(`
      <p class="warning">Pro 後端無法載入：${escapeHtml(String(err.message || err))}</p>
      <p class="muted small">需先套用 pro-630.sql 並部署 pro-api Edge。下方表單仍可嘗試（會如實顯示後端錯誤）。</p>
      <div class="controls controls-start"><button class="btn" id="btn-pro-retry">重新載入</button></div>`));
    box.querySelector('#btn-pro-retry')?.addEventListener('click', () => loadPro(box));
  }
}
