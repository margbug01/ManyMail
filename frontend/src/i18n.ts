import { createSignal } from 'solid-js';
import { LANGS } from './langs';

export type TextKey = keyof typeof LANGS.zh;
type Dict = Record<TextKey, string>;

const [lang, setLangSignal] = createSignal(ManyMailI18n.detect());
export { lang };

const dicts = new Map<string, Dict>();
function dictFor(code: string): Dict {
  let d = dicts.get(code);
  if (!d) dicts.set(code, (d = ManyMailI18n.dict<Dict>(code, 'app', LANGS)));
  return d;
}

// Reads lang(), so text in JSX follows language switches.
export function t(key: TextKey, params?: Record<string, string | number>): string {
  let s: string = dictFor(lang())[key] || LANGS.zh[key] || key;
  if (params) for (const k of Object.keys(params)) s = s.replace(`{${k}}`, String(params[k]));
  return s;
}

function applyDocumentLang(code: string) {
  // email-privacy.js reads <html lang> for its own button labels.
  document.documentElement.lang = ManyMailI18n.info(code).locale;
}
applyDocumentLang(lang());

export function setLang(code: string) {
  const next = ManyMailI18n.normalize(code);
  if (!next || next === lang()) return;
  setLangSignal(next);
  ManyMailI18n.save(next);
  applyDocumentLang(next);
  const frame = document.getElementById('imap-frame') as HTMLIFrameElement | null;
  try {
    frame?.contentWindow?.postMessage({ type: 'manymail-lang-change', lang: next }, window.location.origin);
  } catch {}
  EmailPrivacy.relabel();
}

// 日期、时间格式跟着界面语言走
export const locale = () => ManyMailI18n.locale(lang());

export function fullDate(value?: string): string {
  const d = new Date(value ?? '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale());
}

// 列表里的短时间：今天只显示时:分，今年显示月/日，更早带年份
export function shortDate(value?: string): string {
  const d = new Date(value ?? '');
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const opts: Intl.DateTimeFormatOptions = lang() === 'zh' ? { month: 'numeric', day: 'numeric' } : { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(locale(), opts);
}

export function formatSize(bytes?: number): string {
  const n = Number(bytes) || 0;
  if (!n) return '';
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
}
