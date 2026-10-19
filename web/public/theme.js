// Before first paint, so a light-theme user never sees a dark flash. Same rule as src/lib/theme.ts.
// A file and not an inline <script>, so the CSP (Caddyfile) can stay script-src 'self'.
try {
  var t = localStorage.getItem('talk.theme');
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
} catch (e) {}
