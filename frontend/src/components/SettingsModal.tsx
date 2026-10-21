// 设置：域名管理 + 发信 Resend Key
import { createSignal, createStore, flush, For, Match, Show, Switch } from 'solid-js';
import { errorText, getJSON, postJSON, type Reply } from '../api';
import { t } from '../i18n';
import { loadDomains, state } from '../state';
import { showConfirm, showToast } from '../ui';

interface SenderKey { domain: string; hint?: string; source?: string; unreadable?: boolean }

const [domainError, setDomainError] = createSignal('');
const [openKey, setOpenKey] = createSignal('');
const [keys, setKeys] = createStore<{ status: 'loading' | 'ready' | 'error'; error: string; list: SenderKey[] }>({ status: 'loading', error: '', list: [] });
let modalEl: HTMLElement | undefined;

async function loadSenderKeys() {
  setKeys(s => { s.status = 'loading'; });
  try {
    const resp = await fetch('/api/settings/sender-keys');
    const data: Reply & { domains: SenderKey[] } = await resp.json();
    if (!data.success) throw new Error(data.message || String(resp.status));
    setOpenKey('');
    setKeys(s => {
      s.status = 'ready';
      s.list = data.domains;
    });
  } catch (e) {
    setKeys(s => {
      s.status = 'error';
      s.error = t('loadFailed') + ': ' + errorText(e);
    });
  }
}

export function openSettings() {
  setDomainError('');
  if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
  loadDomains();
  loadSenderKeys();
}

export function SettingsModal() {
  let input!: HTMLInputElement;
  const [adding, setAdding] = createSignal(false);

  async function addDomain() {
    const domain = input.value.trim().toLowerCase();
    setDomainError('');
    if (!domain) return setDomainError(t('enterDomainErr'));
    if (!domain.includes('.') || domain.length < 3) return setDomainError(t('domainInvalid'));
    setAdding(true);
    try {
      const data = await postJSON<Reply>('/api/domains', { domain });
      if (data.success) {
        input.value = '';
        await loadDomains();
      } else {
        setDomainError(data.message || t('loadFailed'));
      }
    } catch (e) {
      setDomainError(t('networkError') + ': ' + errorText(e));
    } finally {
      setAdding(false);
    }
  }

  // 停用域名不可逆，保留确认
  const deleteDomain = (domain: string) => showConfirm({
    title: t('disableDomain'),
    message: t('confirmDisableDomain', { d: domain }),
    okLabel: t('disableDomainOk'),
    onConfirm: async () => {
      setDomainError('');
      try {
        const data = await getJSON<Reply>(`/api/domains/${encodeURIComponent(domain)}`, 'DELETE');
        if (data.success) await loadDomains();
        else setDomainError(data.message || t('deleteFailed'));
      } catch (e) {
        setDomainError(t('networkError') + ': ' + errorText(e));
      }
    },
  });

  return (
    <div class="modal fade" id="settingsModal" tabindex="-1" aria-labelledby="settingsModalLabel" aria-hidden="true" ref={el => { modalEl = el; }}>
      <div class="modal-dialog modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header" style="background:rgba(245,249,247,0.95);border-bottom:1px solid var(--border-color);">
            <h5 class="modal-title" id="settingsModalLabel"><i class="bi bi-gear me-2"></i><span>{t('settings')}</span></h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <strong><i class="bi bi-globe me-2"></i><span>{t('domainMgmt')}</span></strong>
              <div class="d-flex gap-1">
                <a class="btn btn-sm btn-outline-secondary" href="/rules" target="_blank" rel="noopener">
                  <i class="bi bi-signpost-split me-1"></i><span>{t('routingRules')}</span>
                </a>
                <a class="btn btn-sm btn-outline-secondary" href="/dns-check" target="_blank" rel="noopener">
                  <i class="bi bi-shield-check me-1"></i><span>{t('dnsCheck')}</span>
                </a>
                <button class="btn btn-sm btn-outline-secondary" onClick={() => loadDomains()} title={t('refresh')}>
                  <i class="bi bi-arrow-clockwise"></i>
                </button>
              </div>
            </div>
            <div id="domain-list" class="mail-domain-scroll mb-3">
              <Switch>
                <Match when={state.domainsError}><div class="text-danger small">{state.domainsError}</div></Match>
                <Match when={!state.domainsLoaded}><div class="text-center text-muted py-2 small">{t('loading')}</div></Match>
                <Match when={state.domains.length === 0}><div class="text-muted small text-center py-2">{t('noDomains')}</div></Match>
                <Match when={true}>
                  <For each={state.domains}>
                    {d => (
                      <div class="d-flex justify-content-between align-items-center py-1 px-2 mb-1" style="background:#f5f9f7;border-radius:6px;">
                        <span class="small"><i class="bi bi-globe2 me-1 text-muted"></i>{d}</span>
                        <button class="btn btn-sm p-0 text-danger" onClick={() => deleteDomain(d)} title={t('disableDomain')}>
                          <i class="bi bi-x-lg" style="font-size:0.75rem;"></i>
                        </button>
                      </div>
                    )}
                  </For>
                </Match>
              </Switch>
            </div>
            <div class="input-group input-group-sm">
              <input type="text" class="form-control" id="new-domain-input" placeholder={t('enterDomain')} ref={input} />
              <button class="btn btn-primary" onClick={addDomain} id="btn-add-domain" disabled={adding()}>
                <i class="bi bi-plus-lg"></i>
              </button>
            </div>
            <Show when={domainError()}><div id="domain-error" class="text-danger small mt-2">{domainError()}</div></Show>
            <div class="small text-muted mt-2">{t('domainTip')}</div>

            <hr class="my-3" />
            <div class="d-flex justify-content-between align-items-center mb-2">
              <strong><i class="bi bi-key me-2"></i><span>{t('senderKeys')}</span></strong>
            </div>
            <div id="sender-key-list" class="mb-2" style="background:#f5f9f7;border-radius:6px;">
              <Switch>
                <Match when={keys.status === 'loading'}><div class="text-muted small">{t('loading')}</div></Match>
                <Match when={keys.status === 'error'}><div class="text-danger small">{keys.error}</div></Match>
                <Match when={true}>
                  <For each={keys.list}>
                    {item => <SenderKeyRow item={item} open={openKey() === item.domain} onToggle={() => setOpenKey(openKey() === item.domain ? '' : item.domain)} />}
                  </For>
                </Match>
              </Switch>
            </div>
            <div class="small text-muted">{t('senderKeyTip')}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// 一行一个域名：域名 · 当前用哪个 key · 设置/更换；点了才在下面展开输入框（同时只开一个）
function SenderKeyRow(props: { item: SenderKey; open: boolean; onToggle: () => void }) {
  let input!: HTMLInputElement;
  const [note, setNote] = createSignal<{ kind: 'muted' | 'danger'; text: string } | null>(null);
  const [saving, setSaving] = createSignal(false);
  const origin = () => ({ settings: t('keyOriginSettings'), 'env-domain': t('keyFromEnvDomain'), 'env-default': t('keyFromEnvDefault') } as Record<string, string>)[props.item.source || ''] || '';
  const url = () => '/api/settings/sender-keys/' + encodeURIComponent(props.item.domain);

  let saveInFlight = false;

  async function save() {
    if (saveInFlight) return;
    const key = input.value.trim();
    if (!key) { input.focus(); return; }
    saveInFlight = true;
    setSaving(true);
    setNote({ kind: 'muted', text: t('keySaving') });
    try {
      const data = await postJSON<Reply>(url(), { api_key: key }, 'PUT');
      if (!data.success) throw new Error(data.message || t('loadFailed'));
      showToast(props.item.domain + ': ' + data.message, { type: 'success' });
      await loadSenderKeys();
    } catch (e) {
      setNote({ kind: 'danger', text: errorText(e) });
    } finally {
      saveInFlight = false;
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(t('keyConfirmRemove', { domain: props.item.domain }))) return;
    try {
      const data = await getJSON<Reply>(url(), 'DELETE');
      if (!data.success) throw new Error(data.message || t('deleteFailed'));
      showToast(t('keyRemoved', { domain: props.item.domain }), { type: 'success' });
      await loadSenderKeys();
    } catch (e) {
      setNote({ kind: 'danger', text: errorText(e) });
    }
  }

  return (
    <div class="sender-key-row" style="padding:6px 8px;border-bottom:1px solid #eef3f1;">
      <div class="d-flex align-items-center gap-2">
        <span class="small text-truncate" style="flex:1 1 auto;">{props.item.domain}</span>
        <Switch>
          <Match when={props.item.unreadable}><span class="small text-nowrap text-danger">{t('keyUnreadable')}</span></Match>
          <Match when={props.item.hint}>
            <span class="small text-nowrap"><code class="sender-key-hint">{props.item.hint}</code><span class="text-muted ms-1">{origin()}</span></span>
          </Match>
          <Match when={true}><span class="small text-nowrap text-danger">{t('keyNone')}</span></Match>
        </Switch>
        <button type="button" class="btn btn-link btn-sm p-0 text-nowrap"
                onClick={() => {
                  const opening = !props.open;
                  props.onToggle();
                  if (opening) { flush(); input.focus(); }
                }}>
          {props.item.hint || props.item.unreadable ? t('keyChange') : t('keySet')}
        </button>
      </div>
      <div class={['mt-2 sender-key-editor', { 'd-none': !props.open }]}>
        <div class="input-group input-group-sm">
          <input type="password" class="form-control" placeholder={t('keyPlaceholder')} autocomplete="off" ref={input}
                 aria-label={props.item.domain + ' Resend key'} onKeyDown={e => { if (e.key === 'Enter') save(); }} />
          <button class="btn btn-primary" type="button" disabled={saving()} onClick={save}>{t('keySave')}</button>
          <Show when={props.item.source === 'settings' || props.item.unreadable}>
            <button class="btn btn-outline-danger" type="button" onClick={remove}>{t('keyRemove')}</button>
          </Show>
        </div>
        <div class={['small mt-1', note() ? `text-${note()!.kind}` : '']}>{note()?.text}</div>
      </div>
    </div>
  );
}
