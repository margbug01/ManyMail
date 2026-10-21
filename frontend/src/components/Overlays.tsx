// Toasts and the confirm dialog (only for irreversible actions).
import { For } from 'solid-js';
import { t } from '../i18n';
import { acceptConfirm, confirmState, runToastAction, setConfirmElement, toasts } from '../ui';

export function Toasts() {
  return (
    <div id="toast-container" aria-live="polite" aria-atomic="true">
      <For each={toasts.list}>
        {toast => (
          <div class={['app-toast', toast.type ? `toast-${toast.type}` : '', { show: toast.shown }]}>
            <span class="app-toast-text">{toast.message}</span>
            {toast.actionLabel && toast.onAction ? (
              <button type="button" class="app-toast-action" onClick={() => runToastAction(toast)}>{toast.actionLabel}</button>
            ) : null}
          </div>
        )}
      </For>
    </div>
  );
}

export function ConfirmModal() {
  return (
    <div class="modal fade" id="confirmModal" tabindex="-1" aria-labelledby="confirmModalLabel" aria-hidden="true" ref={setConfirmElement}>
      <div class="modal-dialog modal-dialog-centered modal-sm">
        <div class="modal-content">
          <div class="modal-header" style="background:rgba(245,249,247,0.95);border-bottom:1px solid var(--border-color);">
            <h5 class="modal-title" id="confirmModalLabel"><i class="bi bi-exclamation-triangle me-2 text-warning"></i><span id="confirm-title">{confirmState.req?.title || t('confirmTitle')}</span></h5>
          </div>
          <div class="modal-body">
            <p class="mb-0" id="confirm-message">{confirmState.req?.message || ''}</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" id="confirm-cancel">{t('cancel')}</button>
            <button type="button" class="btn btn-danger" id="confirm-ok" onClick={acceptConfirm}>{confirmState.req?.okLabel || t('delete')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
