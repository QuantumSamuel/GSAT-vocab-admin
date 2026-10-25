// ============================================================
// 後台獨立站入口（admin-site）
//
// 與學習站的關係：同一個 Supabase 專案、同一組管理員帳號，但**程式與網址獨立**；
// 不 import 學習站任何頁面、不用 iframe，也不把學習頁當成部署資產。
// 管理員必須在本網站重新登入（session 鍵 vocab2_admin_session，與學習站 vocab2_session 分離）。
//
// 本檔只負責：
//   ① 路由（#/login、#/admin?sec=...）與硬閘
//   ② 登入／登出／權限刷新
//   ③ 使用者選單（email＋登出）
// 後台七區的實際功能仍在 js/pages/admin.js（由 6.0/6.1.2 原檔抽取，功能與文字未改）。
//
// 【授權邊界】這裡的隱藏／擋頁只是 UX；真正的拒絕在伺服器：
//   RLS ＋ security definer RPC 的 is_admin()。前端不持有 service_role。
// ============================================================
import { el, escapeHtml, ICONS } from './core/ui.js';
import { on } from './core/eventbus.js';
import { canManage } from './core/entitlements.js';
import {
  getUser, getProfile, signIn, signOut, initAuth, authReady, refreshProfile, isLoggedIn,
} from './services/auth.js';

const ADMIN_LABEL = '後台';
let renderGeneration = 0;

const main = () => document.getElementById('app');

// 路由代碼：#/admin?sec=users → 'admin'；#/login → 'login'
export function currentRoute() {
  return location.hash.replace(/^#\/?/, '').split('?')[0];
}

// ---------- 頂部標籤與使用者選單（原站同一個 .chrome-bar／.user-menu 元件） ----------
function updateChrome() {
  const label = document.getElementById('top-label');
  if (label) label.textContent = currentRoute() === 'login' ? '' : ADMIN_LABEL;
  const wrap = document.getElementById('user-wrap');
  if (wrap) wrap.hidden = !isLoggedIn();
  renderUserMenu();
}

let menuOpen = false;
function closeUserMenu() {
  document.getElementById('user-menu')?.classList.remove('open');
  menuOpen = false;
}

function renderUserMenu() {
  const menu = document.getElementById('user-menu');
  if (!menu) return;
  const user = getUser();
  menu.innerHTML = user
    ? `<div class="um-email" title="${escapeHtml(user.email || '')}">${escapeHtml(user.email || '')}</div>
       <button id="um-logout">${ICONS.lock}<span>登出</span></button>`
    : '';
  menu.querySelector('#um-logout')?.addEventListener('click', async () => {
    closeUserMenu();
    await signOut();
    location.hash = '#/login';
  });
}

function wireChrome() {
  const fab = document.getElementById('user-fab');
  fab?.addEventListener('click', () => {
    renderUserMenu();
    menuOpen = !menuOpen;
    document.getElementById('user-menu')?.classList.toggle('open', menuOpen);
  });
  document.addEventListener('click', (e) => {
    if (!menuOpen) return;
    if (e.target.closest('#user-menu, #user-fab')) return;
    closeUserMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUserMenu(); }, true);
}

// ---------- 登入畫面（沿用原站 .auth-card 樣式，只做登入；後台不提供註冊） ----------
export function renderLogin(message = '') {
  const page = el(`
    <div class="auth-wrap">
      <section class="card auth-card">
        <div class="auth-brand">
          <div class="auth-logo">管</div>
          <h2 class="auth-title">學測英文單字後台</h2>
        </div>
        <p class="tp-secondary" style="text-align:center;margin:0 0 14px">僅限管理員登入（與學習站分開登入）</p>
        <form id="admin-login-form" autocomplete="on">
          <label class="auth-label">Email
            <input type="email" id="login-email" class="input-shared" autocomplete="username" spellcheck="false" required>
          </label>
          <label class="auth-label">密碼
            <input type="password" id="login-pass" class="input-shared" autocomplete="current-password" required minlength="8">
          </label>
          <p class="warning" id="login-warning"></p>
          <button type="submit" class="btn primary auth-submit" id="login-submit">登入</button>
        </form>
      </section>
    </div>`);
  const warn = page.querySelector('#login-warning');
  warn.textContent = message || '';

  page.querySelector('#admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = page.querySelector('#login-submit');
    const email = page.querySelector('#login-email').value.trim();
    const pass = page.querySelector('#login-pass').value;
    warn.textContent = '';
    btn.disabled = true;
    try {
      await signIn(email, pass); // 內含 profile 重抓（角色以伺服器回傳為準）
      if (!canManage()) {
        // 帳密正確但不是管理員：留在登入頁並明講（不給後台任何資料）
        await signOut();
        renderLogin('此帳號不是管理員，無法進入後台。');
        return;
      }
      location.hash = '#/admin';
    } catch (err) {
      warn.textContent = String(err.message || err);
    } finally {
      btn.disabled = false;
    }
  });
  main().replaceChildren(page);
}

// ---------- 無權限卡（與原站 router 的後台硬閘同一份文字與圖示） ----------
function renderDenied() {
  const card = el(`
    <section class="card error">
      <h2><span class="card-h2-icon">${ICONS.lock}</span>無權限</h2>
      <p>此頁面僅限管理員使用。請以管理員帳號登入後再進入。</p>
      <button class="btn primary" id="btn-goto-login">前往登入</button>
    </section>`);
  card.querySelector('#btn-goto-login').addEventListener('click', async () => {
    await signOut();
    location.hash = '#/login';
  });
  main().replaceChildren(card);
}

function renderFatal(err) {
  main().replaceChildren(el(`
    <section class="card error">
      <h2><span class="card-h2-icon">${ICONS.warn}</span>發生錯誤</h2>
      <p>${escapeHtml(String(err?.message || err))}</p>
    </section>`));
}

// ---------- 主渲染：硬閘 → 懶載入 admin 模組 ----------
export async function render() {
  const gen = ++renderGeneration;
  const route = currentRoute();

  // 已登入者不留在登入頁
  if (route === 'login' && isLoggedIn() && canManage()) { location.hash = '#/admin'; return; }

  if (route === 'login') { updateChrome(); renderLogin(); return; }

  if (!isLoggedIn()) { updateChrome(); location.hash = '#/login'; return; }

  // 冷載／重登競態：等 initAuth 完成才知道角色（原站同一修法）
  await authReady;
  if (gen !== renderGeneration) return;

  if (!canManage()) {
    // 有 session 但 profile 還沒載入（例如剛登入）：先向伺服器確認一次，不沿用舊角色
    if (!getProfile()) {
      try { await refreshProfile(); } catch (err) { updateChrome(); renderDenied(); return; }
      if (gen !== renderGeneration) return;
    }
    updateChrome();
    if (!canManage()) { renderDenied(); return; }
  }

  // 單一路由代碼 admin 以外的落點（含空 hash）一律導回後台
  if (route !== 'admin') { location.replace('#/admin'); return; }

  try {
    const mod = await import('./pages/admin.js');   // 與原站相同的懶載入方式
    if (gen !== renderGeneration) return;
    updateChrome();
    await mod.renderAdmin(main());
  } catch (err) {
    if (gen !== renderGeneration) return;
    renderFatal(err);
  }
}

// ---------- 啟動 ----------
if (location.protocol === 'file:') {
  // 直接點兩下 index.html 開啟時，瀏覽器會擋下 fetch，改顯示操作指引（與原站一致）
  main().replaceChildren(el(`
    <section class="card error">
      <h2><span class="card-h2-icon">${ICONS.warn}</span>請不要直接點兩下 index.html 開啟</h2>
      <p>請執行 <strong>啟動.bat</strong>（或 <code>npm start</code>）啟動本機伺服器後，再用瀏覽器開啟顯示的網址。</p>
    </section>`));
} else {
  wireChrome();
  window.addEventListener('hashchange', () => { render(); });
  on('auth:changed', () => {
    // 跨分頁登出亦須立即移除已顯示的管理資料，不能只更新右上角選單。
    main().replaceChildren();
    updateChrome();
    void render();
  });
  initAuth().then(() => {
    if (!location.hash) location.replace('#/admin');
    render();
  });
}
