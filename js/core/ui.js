// ============================================================
// UI 工具箱（3.0.3 分層重構）：全站共用的 DOM／文字／語音／CSV 工具
// 唯一實作——任何頁面禁止再自帶 escapeHtml／exportCsv 等副本
// ============================================================

// ---------- DOM ----------
// 把 HTML 字串轉成 DOM 元素。
// 單一根元素 → 直接回傳該元素；多個根元素 → 自動包進一個 <div> 回傳。
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const nodes = [...t.content.childNodes].filter(
    (n) => n.nodeType !== 3 || n.textContent.trim() !== ''
  );
  if (nodes.length === 1) {
    return t.content.firstElementChild ?? nodes[0];
  }
  const wrap = document.createElement('div');
  wrap.append(...t.content.childNodes);
  return wrap;
}

// 5.1.8：把「多個根元素」直接變成可一次 replaceChildren 的 DocumentFragment。
// 存在的理由是 el() 的副作用：多根時它包一層無 class 的 <div>，而呼叫端多半是
// replaceChildren(el(...))，於是那層 div 會成為容器的**唯一**子節點。原本的
// 多個子元素全部降級成它的孫節點。
//
// 這個副作用會直接打壞依賴「直屬子節點」的樣式。實測案例（首頁今日任務）：
// .path 設定了 grid-template-columns: repeat(3, 1fr)，但直屬子節點只有那層
// div，於是三欄只放得下「一個 div」——三個 .node 全落在同一格裡垂直堆疊，
// 連線與 START 徽章的位置也跟著錯亂（用戶回報「今日任務的排版仍然不符合要求」，
// 截圖正是三個節點上下疊、卡片右側留一大片空白）。
//
// 用法與 el() 相同（收 HTML 字串），但回傳型別是 DocumentFragment 而非 Element；
// DocumentFragment 本身不可見，replaceChildren / append 會自動把它的子節點搬過去，
// 呼叫端感覺不到差異。
export function elAll(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  // 去掉純空白文字節點，否則會在格子之間產生匿名網格項目影響欄位分佈
  for (const n of [...t.content.childNodes]) {
    if (n.nodeType === 3 && !n.textContent.trim()) t.content.removeChild(n);
  }
  return t.content;
}

// 動態字串插入 HTML 模板前一律 escape（XSS 防線；security 唯一入口）
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---------- 文字 ----------
// ECDICT 音標的次重音符號是「.」，顯示時轉為標準的「ˌ」
export function phoneticPretty(p) {
  return String(p).replace(/^\./, 'ˌ');
}

// 卡片用：把「；」分隔的釋義換成換行
const NL = String.fromCharCode(10); // 避免跳脫序列問題

export function zhLines(s) {
  return String(s ?? '').split('；').filter(Boolean).join(NL);
}

// ---------- 語音（3.0.1 發音鈕） ----------
// Web Speech API，免費、離線可用；不支援的環境靜默跳過
// 4.3.0 修復（用戶回報「聲音無法播放」）：①voices 改為 voiceschanged 事件快取
//（首次互動時 getVoices() 常為空，挑不到英文語音會直接無聲）②cancel() 後同一 tick
// 立刻 speak() 在 Windows Chrome 有靜默競態——僅在真有語音進行中才 cancel，且延後一拍
let __cachedVoices = [];
if ('speechSynthesis' in window) {
  const __refreshVoices = () => { try { __cachedVoices = speechSynthesis.getVoices() || []; } catch { /* noop */ } };
  __refreshVoices();
  speechSynthesis.addEventListener?.('voiceschanged', __refreshVoices);
}

export function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  try {
    const wasSpeaking = speechSynthesis.speaking || speechSynthesis.pending;
    if (wasSpeaking) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'en-US';
    u.rate = 0.9;
    // 4.0.4 修復：Chrome 在 utterance 被 GC 後會靜默不發音——掛到 window 保活；
    // 並優先挑一個英文語音（部分環境預設語音非英文會直接無聲）
    const vs = __cachedVoices.length ? __cachedVoices : speechSynthesis.getVoices();
    const en = vs.find((v) => /^en[-_]US$/i.test(v.lang));
    // 使用者已指定美式；沒有美式voice時明示，不偷偷換成英式或系統預設口音。
    if (!en) { toast('此裝置尚未提供美式英文語音。', 'warn'); return; }
    u.voice = en;
    window.__speakUtterance = u; // 防止 GC
    u.onerror = (e) => console.warn('朗讀失敗：', String(e.error || e));
    if (wasSpeaking) setTimeout(() => speechSynthesis.speak(u), 60); // 避開 cancel/speak 同 tick 競態
    else speechSynthesis.speak(u);
  } catch (err) { /* 朗讀失敗不影響主流程 */ }
}

const SPEAK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg>';

// 發音鈕 HTML：插入頁面後由 initSpeakDelegation() 的全域委派朗讀
export function speakBtn(text) {
  const safe = String(text).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<button class="speak-btn" data-speak="${safe}" title="朗讀" aria-label="朗讀">${SPEAK_SVG}</button>`;
}

// 全域發音委派：app 啟動時呼叫一次
export function initSpeakDelegation() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.speak-btn');
    if (btn) speak(btn.dataset.speak);
  });
}

// ---------- CSV 匯出（2.0.14 起；3.0.3 收敛為唯一實作） ----------
export function dateStr() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// 加 BOM 讓 Excel 正確辨識 UTF-8；欄位含逗號/引號自動跳脫
export function exportCsv(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 4.1.1 Design System：Toast / Dialog / EmptyState ----------

// Toast：一般訊息用目前 Accent 色；ok/bad 為 semantic（真正成功/失敗才用）
export function toast(msg, kind = 'accent') {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    document.body.appendChild(region);
  }
  const t = el(`<div class="toast ${kind === 'ok' ? 'toast-ok' : kind === 'bad' ? 'toast-bad' : ''}">${escapeHtml(String(msg))}</div>`);
  region.appendChild(t);
  setTimeout(() => { t.remove(); }, 2600);
}

// Dialog（M3 結構＋Soft Minimal）：替代原生 confirm 的共用元件
// opts: { title, body, bodyHtml, danger, okText, cancelText, input, value, placeholder }
//   → Promise<boolean>；input 模式回傳 Promise<string|null>（OK＝輸入值，Cancel/Escape＝null）
// 4.1.1 補：focus 還原——開啟時記下觸發者，關閉後焦點回到原處（鍵盤操作不斷鏈）
// 4.2.0 補：Escape 關閉＋input 模式（取代原生 prompt()，回傳字串或 null）
export function openDialog(opts) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement; // 4.1.1：記錄開啟前的焦點錨點
    const inputHtml = opts.input
      ? `<input class="dlg-input" type="text" value="${escapeHtml(opts.value ?? '')}"
             placeholder="${escapeHtml(opts.placeholder || '')}" spellcheck="false">`
      : '';
    const ov = document.createElement('div');
    ov.className = 'dlg-overlay';
    ov.appendChild(el(`
      <div class="dlg" role="dialog" aria-modal="true" aria-label="${escapeHtml(opts.title || '')}">
        <div class="dlg-title">${escapeHtml(opts.title || '')}</div>
        <div class="dlg-body ${opts.danger ? 'dlg-danger' : ''}">${opts.bodyHtml ? opts.bodyHtml : escapeHtml(opts.body || '')}</div>
        ${inputHtml}
        <div class="dlg-actions">
          <button class="btn" data-r="0">${escapeHtml(opts.cancelText || '取消')}</button>
          <button class="btn ${opts.danger ? 'danger' : 'primary'}" data-r="1">${escapeHtml(opts.okText || '確定')}</button>
        </div>
      </div>`));
    const input = ov.querySelector('.dlg-input');
    const done = (v) => {
      ov.remove();
      // 焦點還原：元素可能已隨重繪被移除，focus() 會靜默失敗，故先確認仍在文件中
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
      resolve(v);
    };
    const close = (ok) => {
      if (opts.input) done(ok ? (input ? input.value : '') : null); // 4.2.0：輸入模式回字串或 null
      else done(ok);
    };
    ov.addEventListener('click', (e) => {
      if (e.target === ov) close(false);
      const b = e.target.closest('[data-r]');
      if (b) close(b.dataset.r === '1');
    });
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); } // 4.2.0：Escape＝取消
      if (e.key === 'Enter' && input && e.target === input) { e.preventDefault(); close(true); }
    });
    document.body.appendChild(ov);
    if (input) { input.focus(); input.select(); }
    else ov.querySelector('[data-r="1"]').focus();
  });
}

// Empty state（SVG icon＋標題＋說明＋可選動作）
export function emptyState({ icon = 'box', title, desc = '', actionHtml = '' }) {
  const ICONS = {
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    wifi: '<path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M2 8.5a15 15 0 0 1 20 0"/><path d="M12 19h.01"/>',
  };
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ICONS.box}</svg>
    <div class="es-title">${escapeHtml(title)}</div>
    ${desc ? `<div class="es-desc">${escapeHtml(desc)}</div>` : ''}
    ${actionHtml}
  </div>`;
}

// 公用 SVG 圖標（4.1.1：取代 emoji / unicode UI icon）
export const ICONS = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4M12 17.5h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 7"/></svg>',
  // 實心／空心星：標記「不會」與加入複習按鈕（搭配按鈕文字使用，aria-label 由呼叫端給）
  star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3.6l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/></svg>',
  starOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/></svg>',
  // 左右 chevron：翻頁／上一題／下一題（搭配按鈕文字使用）
  chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  // ── 4.2.0 新增（10 候選圖標，用戶 2026-10-02 圖標總覽頁拍板採用；emoji 禁令的替換圖標） ──
  warnTriangle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M5 21h14"/></svg>',
  chevronUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7h12m0 0l-3-3m3 3l-3 3M16 17H4m0 0l3 3m-3-3l3-3"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>',
  arrowUpRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7m0 0h-7m7 0v7"/></svg>',
  // 4.2.0：更多操作（三圓點，實心 currentColor）——後台使用者列的「⋯」按鈕
  dots: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  // 5.0.4 F 項：後台「使用者」「反饋」分區標題補圖標（原 ICONS 表缺這兩型，主線自繪）
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.2 3.8-5 7-5s5.8 1.8 7 5"/></svg>',
  message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H5l1.5-3A8 8 0 1 1 21 12z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/></svg>',
  // 5.1.1 動效（B0）：答題回饋的對勾與錯誤叉（stroke 線條風，與既有圖示同風格）。
  // tick 自帶 d1-tick class：style.css「5.1.1 動效」的描繪動畫以 .d1-tick path 為選擇器，
  // 圖示字串直接帶 class，插入回饋區即具備描繪能力（一般勾勾用既有 check，勿拿 tick 當通用圖標，
  //   也勿再套 iconInline，重複 class 屬性會讓描繪樣式失效）。
  tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="d1-tick"><path d="M4 12l5 5L20 7"/></svg>',
  // cross 供答錯顯示（用戶指定「顯示錯誤叉」的零 emoji 實現）；與 tick 同粗細成對出現
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/**
 * 4.2.0：星級徽章（n 顆實心星 SVG，examStarCount 的 UI 替代——emoji 禁令）。
 * n<=0 回空字串；size 可調（預設 12px 內聯樣式交由呼叫端 class 控制）。
 */
export function starsSvg(n, size = 12) {
  const star = ICONS.star.replace('<svg ', `<svg width="${size}" height="${size}" `);
  return n > 0 ? star.repeat(n) : '';
}

/**
 * 4.2.0：行內小圖標工具——把 ICONS 的 svg 補上 width/height 與 .ic-inline class。
 * 用途：純文字段落（說明、選項、提示行）裡要放圖標時，這些位置沒有對應的
 * CSS 選擇器可撐尺寸，故直接內聯尺寸屬性；不新增任何 path，只重用 ICONS。
 * icon 可傳 ICONS 的 key（'warnTriangle'…）或已取得的 svg 字串。
 */
export function iconInline(icon, size = 14, cls = 'ic-inline') {
  const svg = ICONS[icon] || icon;
  return svg.replace('<svg ', `<svg class="${cls}" width="${size}" height="${size}" `);
}
