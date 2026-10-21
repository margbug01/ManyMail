// 第1栏：查询 + 最近邮箱（窄屏为 Bootstrap offcanvas 抽屉，show/hide 类名归 Bootstrap 管）
import { For, Show } from 'solid-js';
import { t } from '../i18n';
import { clearRecentMailboxes, isStaleMailbox, queryInbox, removeRecentMailbox, setState, state, useRecentMailbox } from '../state';
import { copyText } from '../ui';
import { selectValue } from '../dom';

export function QueryPanel() {
  return (
    <div class="col-12 col-lg-3 mail-col mail-left offcanvas-lg offcanvas-start" tabindex="-1"
         id="mail-left-column" aria-labelledby="mailLeftLabel" style={{ display: state.tab === 'imap' ? 'none' : undefined }}>
      <div class="offcanvas-header">
        <h5 class="offcanvas-title" id="mailLeftLabel">{t('queryInbox')}</h5>
        <button type="button" class="btn-close" data-bs-dismiss="offcanvas" data-bs-target="#mail-left-column" aria-label="Close"></button>
      </div>
      <div class="offcanvas-body flex-column gap-3">
        <div class="card mail-query-card">
          <div class="card-header">
            <i class="bi bi-search me-2"></i><span>{t('queryInbox')}</span>
          </div>
          <div class="card-body">
            <div class="mb-3">
              <label class="form-label" for="inbox-domain">{t('selectDomain')}</label>
              <select class="form-select" id="inbox-domain" ref={selectValue(() => state.form.domain, () => state.domains.join())}
                      onChange={e => setState(s => { s.form.domain = e.currentTarget.value; })}>
                <Show when={state.domainsLoaded} fallback={<option value="">{t('loading')}</option>}>
                  <For each={state.domains}>{d => <option value={d}>{d}</option>}</For>
                </Show>
              </select>
            </div>
            <div class="mb-3">
              <label class="form-label" for="inbox-prefix">{t('emailPrefix')}</label>
              <div class="input-group">
                <input type="text" class="form-control" id="inbox-prefix" placeholder={t('enterPrefix')} value={state.form.prefix}
                       onInput={e => setState(s => { s.form.prefix = e.currentTarget.value; })}
                       onKeyDown={e => { if (e.key === 'Enter') queryInbox(); }} />
                <span class="input-group-text" id="inbox-domain-display">@{state.form.domain || 'damnv.lol'}</span>
              </div>
              <small class="text-muted">{t('prefixExample')}</small>
            </div>
            <button class="btn btn-primary w-100" onClick={() => queryInbox()} id="btn-query-inbox" disabled={state.querying}>
              <Show when={state.querying} fallback={<><i class="bi bi-search me-1"></i><span>{t('query')}</span></>}>
                <span class="spinner-border spinner-border-sm me-1"></span>{t('querying')}
              </Show>
            </button>
            <Show when={state.queryError}>
              <div id="inbox-error" class="alert alert-danger mt-3">{state.queryError}</div>
            </Show>
            <div class="small text-muted mt-3">{t('domainTip')}</div>
          </div>
        </div>

        <Show when={state.recent.length > 0}>
          <div class="card mail-recent-card" id="recent-card">
            <div class="card-header d-flex justify-content-between align-items-center">
              <span><i class="bi bi-clock-history me-2"></i><span>{t('recentMailboxes')}</span></span>
              <button class="btn btn-sm btn-outline-secondary" onClick={clearRecentMailboxes} title={t('clearRecent')}>
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
            <div class="card-body">
              <div id="recent-list" class="mail-recent-scroll d-flex flex-wrap gap-2">
                <For each={state.recent}>
                  {email => (
                    <span class={['recent-pill', { 'recent-stale': isStaleMailbox(email) }]} title={isStaleMailbox(email) ? t('recentStale') : email}>
                      <span class="recent-pill-label" onClick={() => { if (!isStaleMailbox(email)) useRecentMailbox(email); }}>{email}</span>
                      <button type="button" class="recent-pill-copy" onClick={e => copyText(email, e)} title={t('copyMailbox')} aria-label="copy">
                        <i class="bi bi-clipboard"></i>
                      </button>
                      <button type="button" class="recent-pill-remove" onClick={() => removeRecentMailbox(email)} aria-label="remove">
                        <i class="bi bi-x-lg"></i>
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
