// Toasts, the confirm dialog and clipboard: page-wide UI used by every area.
import { createStore } from 'solid-js';
import { t } from './i18n';

export interface Toast {
  id: number;
  message: string;
  type?: 'success' | 'error';
  actionLabel?: string;
  onAction?: () => void;
  shown: boolean;
}

export const [toasts, setToasts] = createStore<{ list: Toast[] }>({ list: [] });
let toastSeq = 0;
const dismissers = new Map<number, () => void>();

export function showToast(message: string, options: { type?: Toast['type']; actionLabel?: string; onAction?: () => void; duration?: number } = {}) {
  const id = ++toastSeq;
  setToasts(s => { s.list.push({ id, message, type: options.type, actionLabel: options.actionLabel, onAction: options.onAction, shown: false }); });
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    dismissers.delete(id);
    clearTimeout(timer);
    setToasts(s => { const x = s.list.find(x => x.id === id); if (x) x.shown = false; });
    setTimeout(() => setToasts(s => { s.list = s.list.filter(x => x.id !== id); }), 220);
  };
  // Two frames: the element must be painted without .show first, or the transition does not run.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!dismissed) setToasts(s => { const x = s.list.find(x => x.id === id); if (x) x.shown = true; });
  }));
  const timer = setTimeout(dismiss, options.duration || (options.actionLabel ? 6000 : 3200));
  dismissers.set(id, dismiss);
  return dismiss;
}

export function runToastAction(toast: Toast) {
  dismissers.get(toast.id)?.();
  toast.onAction?.();
}

export const toastError = (message: string) => showToast(message, { type: 'error' });

// ---- 自定义确认弹窗，只用于不可逆操作 ----
export interface ConfirmRequest { title?: string; message?: string; okLabel?: string; onConfirm: () => void }

export const [confirmState, setConfirmState] = createStore<{ req: ConfirmRequest | null }>({ req: null });
let confirmEl: HTMLElement | undefined;
export const setConfirmElement = (el: HTMLElement) => { confirmEl = el; };

export function showConfirm(req: ConfirmRequest) {
  setConfirmState(s => { s.req = req; });
  if (confirmEl) bootstrap.Modal.getOrCreateInstance(confirmEl).show();
}

export function acceptConfirm() {
  const req = confirmState.req;
  if (confirmEl) bootstrap.Modal.getOrCreateInstance(confirmEl).hide();
  req?.onConfirm();
}

// ---- 复制到剪贴板 ----
export async function copyText(text: string, event?: Event) {
  event?.stopPropagation();
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // http 环境下 navigator.clipboard 不可用，退回 execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('execCommand failed');
    }
    showToast(t('copied', { v: text }), { type: 'success', duration: 1800 });
  } catch {
    toastError(t('copyFailed'));
  }
}
