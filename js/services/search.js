// ============================================================
// 單字搜尋服務（3.0.3 分層重構）：全站唯一的字庫索引
// 查詢頁（lookup）與單詞本導入驗證（unknown）共用同一套，
// 終結兩套索引行為不一致的問題
// 5.0.x：變化形（went／goes／going）命中 words.json 的 tense 欄位時歸併到原形條目
//   （spec 5.7 第 7 節）。資料面只用既有 tense 欄位與既有 expandWord，不做資料擴充。
// ============================================================
import { getWords } from './vocab.js';

let byWord = null; // 小寫單字（含展開形式）→ 單字資料
let byId = null;   // id → 單字資料

// 展開合併形式：'a/an'、'he (him, his)'（歷史資料相容）→ 多個查找鍵
function expandWord(word) {
  const s = String(word).toLowerCase().replace(/\s+/g, '');
  const keys = new Set([s]);
  for (const part of s.split('/')) {
    keys.add(part);
    const m = part.match(/^(.+?)\(([^()]+)\)(.*)$/);
    if (m) {
      const [, base, opt, tail] = m;
      keys.add(base + tail);
      keys.add(base + opt + tail);
      if (opt.includes(',')) {
        for (const item of opt.split(',')) {
          if (item.trim()) keys.add(item.trim());
        }
      }
    }
  }
  keys.delete('');
  return [...keys];
}

/**
 * 5.0.x（spec 5.7 第 7 節）：words.json 的 tense 欄位（實測 2,617 字有）展開成查找鍵。
 * 為什麼索引的鍵要帶「原形」資訊：變化形查到的必須是**原形條目**（同一個 word 物件），
 *   這樣加入單詞本／加入複習拿到的是原形的 id，SRS 佇列不會被變體灌爆（spec 第 7 節後半）。
 * 【與「原形優先」的差別——池 B 對向驗證第 3 項】兩階段索引：
 *   ① 第一階段只放「字面／既有展開」鍵（2.x 以來的行為，一字不改）：此時 map 的每個鍵
 *      都能對回一個**字庫裡真的存在的字**（或該字的別名鍵）。
 *   ② 第二階段才放 tense 變化形鍵，且**只放第一階段查不到的字**。
 *      為什麼必須這樣：arms（arm 的複數、字庫也有）、being（be 的分詞、字庫也有）、
 *      born（bear 的過去式、字庫也有，Lv1）這類「既是某字的變化形、又是字庫獨立條目」共有
 *      225 組，若先到先得就被父詞劫持——使用者查一個實字卻拿到另一個字。
 *      查詢頁因 findWordWithTense 標了 viaTense，畫面上還會出現「這是 arm 的變化形」，
 *      對一個本來就存在的字說這句話是錯的。
 */
function tenseKeys(w) {
  const t = w?.tense;
  if (!t || typeof t !== 'object') return [];
  return [t.s, t.past, t.pp, t.ing]
    .map((v) => String(v ?? '').trim().toLowerCase())
    .filter((v) => v && v !== String(w.word).toLowerCase());
}

export function wordIndex() {
  if (!byWord) {
    // 4.1.0 修復（索引毒化）：先建局部 Map，成功後才寫入模組快取——
    // getWords() 拋錯時 byWord 保持 null，下次呼叫會重試而非永久卡在空索引
    const words = getWords();
    // ① 字面／既有展開（'a/an'、括號形式）——與 2.x 完全相同：重複單字保留第一筆
    const map = new Map();
    for (const w of words) {
      for (const key of expandWord(w.word)) {
        if (!map.has(key)) map.set(key, w);
      }
    }
    // ② tense 變化形 → 原形條目：只補「① 查不到」的鍵（＝字庫裡沒這個字，確實是變化形）
    for (const w of words) {
      for (const key of tenseKeys(w)) {
        if (!map.has(key)) map.set(key, w);
      }
    }
    byWord = map;
  }
  return byWord;
}

/**
 * 5.0.x：這次查詢是「直接命中原形」還是「命中變化形」？
 * 回傳 { word, viaTense, raw }：viaTense=true 代表使用者打的是變化形
 * （查詢頁据此顯示「這是 X 的變化形」提示；spec 5.7 第 7 節 ①）。
 * 查不到回 null。既有 findWord 語意不變（只回條目），這是給 UI 用的加值查詢。
 */
export function findWordWithTense(token) {
  const raw = String(token ?? '').trim().toLowerCase();
  if (!raw) return null;
  const w = findWord(raw);
  if (!w) return null;
  // viaTense 的判準＝「這次打的是該條目的變化形」：
  //   ① raw 必須在該條目的 tenseKeys 裡；
  //   ② 但若 raw 已經是**展開鍵**（'a/an'、'forward/forwards' 這類別名），
  //      那就是命中該條目本身的字面／別名（2.x 以來的既有行為），不該提示變化形。
  //      資料事實：'forward/forwards'（id 1380）的 tense.s 恰好就是 'forwards'，
  //      沒有 ② 就會對一個既有的別名條目多打一句「這是 forward/forwards 的變化形」。
  const viaTense = tenseKeys(w).includes(raw) && !expandWord(w.word).includes(raw);
  return { word: w, viaTense, raw };
}

export function idIndex() {
  if (!byId) {
    const map = new Map(); // 4.1.0 修復：同 wordIndex，失敗不留半成品
    for (const w of getWords()) map.set(w.id, w);
    byId = map;
  }
  return byId;
}

// 精確查一個字（已 lowercase）
export function findWord(token) {
  return wordIndex().get(String(token).toLowerCase()) ?? null;
}

// 批次驗證（單詞本導入用）：回傳 { valid:[word], invalid:[token] }，自動去重
export function verifyTokens(tokens) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const t of tokens) {
    const w = wordIndex().get(String(t).toLowerCase());
    if (!w) { invalid.push(t); continue; }
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    valid.push(w);
  }
  return { valid, invalid };
}

// 切分輸入：空格／逗號／分號／頓號／換行／tab（單詞本導入與後台發佈共用）
// 4.0.2：先展開「word(變化1, 變化2)」括號形式（如 coincidence(coincide, coincidental)
// → coincidence coincide coincidental）；大小寫視為同一字去重（保留原順序與原寫法）
export function parseWordTokens(text) {
  const expanded = String(text || '')
    .replace(/([A-Za-z][A-Za-z'\u2019\-]*)\s*\(([^()]+)\)/g, (_m, base, inner) => `${base} ${inner}`);
  const seen = new Set();
  const out = [];
  for (const tok of expanded.split(/[\s,;，；、]+/)) {
    const w = tok.replace(/^[.。'"()（）]+|[.。'"()（）]+$/g, '');
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

// ---------- 相近字建議（查詢頁查不到時） ----------
export function suggestions(q) {
  const lower = q.toLowerCase();
  const starts = [];
  const contains = [];
  const typos = [];
  for (const key of wordIndex().keys()) {
    if (key === lower) continue;
    if (key.startsWith(lower)) starts.push(key);
    else if (lower.length >= 3 && key.includes(lower)) contains.push(key);
    else if (Math.abs(key.length - lower.length) <= 2 && editDistance(key, lower) <= 2) typos.push(key);
  }
  const out = [...starts.slice(0, 8), ...contains.slice(0, 4)];
  if (out.length === 0) out.push(...typos.sort((a, b) => a.length - b.length).slice(0, 5));
  return out;
}

// 簡易編輯距離（錯字建議用；字庫 7100 字逐一比對也夠快）
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99; // 快速排除，避免長度差太多的字做完整比對
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,        // 刪除
        cur[j - 1] + 1,     // 插入
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // 替換
      );
    }
    prev = cur;
  }
  return prev[n];
}
