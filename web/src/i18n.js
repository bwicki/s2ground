// i18n: all visible strings live in web/i18n/<lang>.json (DE is the reference).
// t('key', {n: 3}) substitutes {n}. A missing key falls back to the DE text, then to the key
// itself – so a forgotten translation shows up as a readable key instead of breaking the view.

const LS_KEY = 's2ground.lang';
const dicts = { de: null, en: null };
let lang = 'de';
const listeners = new Set();

export function currentLang() { return lang; }

export async function initI18n() {
  const saved = (() => { try { return localStorage.getItem(LS_KEY); } catch { return null; } })();
  lang = saved === 'en' ? 'en' : 'de';
  await Promise.all(['de', 'en'].map(async (l) => {
    const res = await fetch(`./i18n/${l}.json`, { cache: 'no-cache' });
    dicts[l] = await res.json();
  }));
  document.documentElement.lang = lang;
}

export async function setLang(l) {
  if (l !== 'de' && l !== 'en') return;
  lang = l;
  try { localStorage.setItem(LS_KEY, l); } catch { /* private mode */ }
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn(lang));
}

export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function t(key, params) {
  let s = (dicts[lang] && dicts[lang][key]) ?? (dicts.de && dicts.de[key]) ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Keys of the DE dictionary (used by tests to check EN completeness). */
export function allKeys() { return Object.keys(dicts.de || {}); }
