// ============================================================
// 字庫資料（admin-site 版：只保留「單字表」）
//
// 來源：6.0/6.1.2/js/services/vocab.js
//   後台只用到「字庫」：預設單詞本發佈前的字詞驗證（verifyTokens）、
//   「待補單字」判定（findWord）、6000 單字一鍵佈建的字庫內外分流。
//   原站的 loadExam／loadSentences／loadCollocations 是學習頁（模擬考／查詢／例句）用的
//   資料載入器，後台不需要，故不搬（避免把學習站資料檔變成後台必要資產）。
//
// 回傳契約（與原站相同，改動前請先讀這裡）
//   loadWords() → 回傳「字單物件陣列」；失敗拋出（呼叫端以 try/catch 顯示提示）
//   getWords()  → 尚未載入時拋錯（呼叫端據此顯示「字庫未載入」提示）
// 資料檔：data/words.json（公開字庫，與原站同一份；非題庫）
// ============================================================
let words = null; // 單字陣列
let meta = null;  // 字庫資訊（來源、產生日期等）

let wordsPromise = null;
export async function loadWords() {
  if (words) return words;
  if (!wordsPromise) {
    wordsPromise = (async () => {
      const res = await fetch('data/words.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`載入字庫失敗（HTTP ${res.status}）`);
      const data = await res.json();
      // 4.1.0 修復：空/壞字庫不得靜默通過（會把空索引永久快取）
      if (!data || !Array.isArray(data.words) || !data.words.length) throw new Error('字庫資料格式錯誤');
      words = data.words;
      meta = data.meta ?? {};
      return words;
    })();
  }
  const mine = wordsPromise;
  try {
    return await mine;
  } finally {
    if (wordsPromise === mine && !words) wordsPromise = null; // 失敗不鎖死；identity 檢查防交錯誤清
  }
}

export function getWords() {
  if (!words) throw new Error('字庫尚未載入，請先呼叫 loadWords()');
  return words;
}

export function getMeta() {
  return meta;
}
