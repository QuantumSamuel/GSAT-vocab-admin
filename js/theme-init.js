// 開場即套用深色模式與字體大小（避免閃爍；app.js 會再套一次）
// 4.0.3：由 index.html 的 inline script 抽出為外部檔——配合 CSP script-src 'self'
try {
  var _old = localStorage.getItem('vocab2_theme');
  if (_old !== null) {
    if (_old === 'dark') localStorage.setItem('vocab2_mode', 'dark');
    if (_old === 'paper') localStorage.setItem('vocab2_accent', 'orange');
    if (_old === 'ink') localStorage.setItem('vocab2_accent', 'blue');
    localStorage.removeItem('vocab2_theme');
  }
  var _m = localStorage.getItem('vocab2_mode') || 'auto';
  var _dark = _m === 'dark' ||
    (_m === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var _a = localStorage.getItem('vocab2_accent') || 'blue';
  document.documentElement.dataset.mode = _dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = _a;
  if (_dark) document.documentElement.classList.add('dark');
  var _f = localStorage.getItem('vocab2_font');
  if (_f) document.documentElement.classList.add('font-' + _f);
  document.documentElement.dataset.anim = localStorage.getItem('vocab2_anim') || 'flip';
} catch (e) {}
