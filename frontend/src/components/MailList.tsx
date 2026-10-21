// 第2栏：文件夹切换、自动刷新、搜索、批量操作和邮件列表
import { createEffect, createMemo, For, Match, onSettled, Show, Switch } from 'solid-js';
import type { Message, SentMessage } from '../api';
import { fullDate, lang, shortDate, t } from '../i18n';
import {
  AUTO_REFRESH_INTERVAL, batchAction, clearSearch, loadFolder, loadMoreInbox, refreshCurrentTab, refreshInboxSilently,
  reloadInbox, setAllSelected, setAutoRefresh, setState, state, switchTab, toggleSelected, viewMailDetail, viewSentDetail,
  searchMail, type Folder,
} from '../state';
import { copyText } from '../ui';
import { segClass } from './Navbar';

const FOLDER_BUTTONS: { folder: Folder; icon: string }[] = [
  { folder: 'inbox', icon: 'bi-envelope-open' },
  { folder: 'sent', icon: 'bi-send' },
  { folder: 'trash', icon: 'bi-trash' },
];

export function MailList(props: { reloadImap: () => void }) {
  let header!: HTMLDivElement;
  let card!: HTMLDivElement;

  const unread = createMemo(() => state.inbox.items.filter(m => !m.seen).length);
  // 收件箱里正在显示的：搜索结果或整页列表
  const shown = createMemo(() => (state.search.active ? state.search.items : state.inbox.items));
  const allChecked = createMemo(() => shown().length > 0 && shown().every(m => state.selected.includes(m.id)));

  // 卡片头一行放不下时先收文件夹文字、再收「自动」。CSS 容器查询的阈值是按中英文量的，
  // 法语、俄语这类长文字要实际量：最后一组掉到第一组下面就算折行了
  const fitListHeader = () => {
    if (!header || !header.getClientRects().length) return;
    const wraps = () => {
      const kids = header.children;
      return kids[kids.length - 1].getBoundingClientRect().top >= kids[0].getBoundingClientRect().bottom - 1;
    };
    header.classList.remove('compact-tabs', 'compact-auto');
    if (wraps()) header.classList.add('compact-tabs');
    if (wraps()) header.classList.add('compact-auto');
  };
  createEffect(() => [lang(), unread(), state.tab] as const, () => fitListHeader());
  onSettled(() => {
    // 看卡片的宽度而不是卡片头本身：收起文字会改变卡片头的高度，不能让它自己触发自己
    if (!window.ResizeObserver) return;
    const ro = new ResizeObserver(fitListHeader);
    ro.observe(card);
    return () => ro.disconnect();
  });

  // 自动刷新只服务收件箱
  createEffect(() => state.autoRefresh && state.tab === 'inbox' && state.email, on => {
    if (!on) return;
    const timer = setInterval(refreshInboxSilently, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  });

  return (
    <div class="col-12 col-lg-4 mail-col" id="mail-list-column" style={{ display: state.tab === 'imap' ? 'none' : undefined }}>
      <div class="card h-100" ref={card}>
        <div class="card-header mail-list-header d-flex flex-wrap justify-content-between align-items-center gap-2" ref={header}>
          <div class="btn-group btn-group-sm nav-tabs-group" id="folder-seg" role="group">
            <For each={FOLDER_BUTTONS}>
              {b => (
                <button type="button" id={`tab-${b.folder}`} class={segClass(state.tab === b.folder)} title={t(b.folder)}
                        aria-pressed={state.tab === b.folder ? 'true' : 'false'} onClick={() => switchTab(b.folder)}>
                  <i class={`bi ${b.icon} me-1`}></i><span class="folder-label">{t(b.folder)}</span>
                  <Show when={b.folder === 'inbox'}>
                    <span id="unread-badge" class="badge ms-1" style={{ display: unread() > 0 ? 'inline' : 'none', background: 'var(--navy)', 'font-size': '0.7em' }}>
                      {unread() > 99 ? '99+' : unread()}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-auto">
            <div class="form-check form-switch mb-0" title={t('autoRefreshTitle')}>
              <input class="form-check-input" type="checkbox" id="auto-refresh-toggle" checked={state.autoRefresh}
                     onChange={e => {
                       const box = e.currentTarget;
                       setAutoRefresh(box.checked);
                       // 收件箱以外或还没查邮箱时开不了，勾选框要退回去
                       if (box.checked && !(state.tab === 'inbox' && state.email)) box.checked = false;
                     }} />
              <label class="form-check-label small" for="auto-refresh-toggle">{t('auto')}</label>
            </div>
            <button class="btn btn-sm btn-outline-secondary" onClick={() => refreshCurrentTab(props.reloadImap)} id="btn-refresh-mail" disabled={!state.email || state.querying}>
              <i class="bi bi-arrow-clockwise"></i>
            </button>
          </div>
        </div>
        <div class="card-body mail-list-body">
          <div class="mail-list-toolbar">
            <div class="input-group input-group-sm" id="search-bar" style={{ display: state.tab === 'inbox' && state.email ? 'flex' : 'none' }}>
              <input type="text" class="form-control" id="search-input" placeholder={t('searchPlaceholder')} title={t('searchHint')}
                     value={state.search.input} onInput={e => setState(s => { s.search.input = e.currentTarget.value; })}
                     onKeyDown={e => { if (e.key === 'Enter') searchMail(); }} />
              <button class="btn btn-outline-secondary" onClick={() => searchMail()} id="btn-search">
                <i class="bi bi-search"></i>
              </button>
              <button class="btn btn-outline-secondary" onClick={clearSearch} title={t('clearSearchTitle')}>
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
            <div id="batch-bar" class="d-flex align-items-center gap-2"
                 style={state.tab === 'inbox' && state.email && state.inbox.status === 'ready' && shown().length > 0 ? 'display:flex !important;' : 'display:none !important;'}>
              <div class="form-check mb-0">
                <input class="form-check-input" type="checkbox" id="select-all-checkbox" checked={allChecked()}
                       onChange={e => setAllSelected(shown().map(m => m.id), e.currentTarget.checked)} />
                <label class="form-check-label small" for="select-all-checkbox">{t('selectAll')}</label>
              </div>
              <span class="small text-muted" id="selected-count">{state.selected.length > 0 ? t('selected', { n: state.selected.length }) : ''}</span>
              <button class="btn btn-sm btn-outline-danger" onClick={() => batchAction('delete')} id="btn-batch-delete" disabled={state.selected.length === 0}>
                <i class="bi bi-trash me-1"></i><span>{t('delete')}</span>
              </button>
              <button class="btn btn-sm btn-outline-secondary" onClick={() => batchAction('mark_read')} id="btn-batch-read" disabled={state.selected.length === 0}>
                <i class="bi bi-check2-all me-1"></i><span>{t('markRead')}</span>
              </button>
            </div>
          </div>
          <div id="mail-list" class="mail-list-scroll">
            <Switch>
              <Match when={state.tab === 'inbox'}><InboxList shown={shown()} /></Match>
              <Match when={state.tab === 'sent'}><FolderList folder="sent" /></Match>
              <Match when={state.tab === 'trash'}><FolderList folder="trash" /></Match>
            </Switch>
          </div>
        </div>
      </div>
    </div>
  );
}

const Spinner = (props: { text: string }) => (
  <div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> {props.text}</div>
);

const Hint = (props: { text: string }) => (
  <div class="text-center text-muted py-4"><i class="bi bi-arrow-left me-2"></i>{props.text}</div>
);

const ErrorState = (props: { text: string; icon?: boolean }) => (
  <div class="error-state">
    <Show when={props.icon}><i class="bi bi-exclamation-triangle d-block"></i></Show>
    <p>{props.text}</p>
  </div>
);

const Skeleton = () => (
  <>
    <div class="card mb-2">
      <div class="card-body py-3">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-text" style="width:80%"></div>
        <div class="skeleton skeleton-text" style="width:60%"></div>
      </div>
    </div>
    <div class="card mb-2">
      <div class="card-body py-3">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-text" style="width:75%"></div>
      </div>
    </div>
  </>
);

function LoadMore(props: { count: number; total: number; loading: boolean; onClick: () => void; id?: string }) {
  return (
    <div class="text-center py-3">
      <button class="btn btn-outline-primary btn-sm" id={props.id} disabled={props.loading} onClick={() => props.onClick()}>
        <Show when={props.loading} fallback={<><i class="bi bi-arrow-down-circle me-1"></i>{t('loadMore')} ({props.count}/{props.total})</>}>
          <span class="spinner-border spinner-border-sm me-1"></span>{t('loading')}
        </Show>
      </button>
    </div>
  );
}

function InboxList(props: { shown: Message[] }) {
  return (
    <Switch fallback={<Hint text={t('queryHint')} />}>
      <Match when={state.inbox.status === 'loading'}><Skeleton /></Match>
      <Match when={state.inbox.status === 'error'}><ErrorState icon text={state.inbox.error} /></Match>
      <Match when={!state.email}><Hint text={t('queryHint')} /></Match>
      <Match when={state.search.active && state.search.status === 'loading'}><Spinner text={t('searching')} /></Match>
      <Match when={state.search.active && state.search.status === 'error'}><ErrorState text={state.search.error} /></Match>
      <Match when={state.search.active && props.shown.length === 0}>
        <div class="empty-state">
          <i class="bi bi-search d-block"></i>
          <p>{t('noMatch')}</p>
          <button class="btn-refresh" onClick={clearSearch}><i class="bi bi-x-lg"></i>{t('clearSearchBtn')}</button>
        </div>
      </Match>
      <Match when={props.shown.length === 0}>
        <div class="empty-state">
          <i class="bi bi-inbox d-block"></i>
          <p>{t('inboxEmpty')}</p>
          <button class="btn-refresh" onClick={() => reloadInbox()}><i class="bi bi-arrow-clockwise"></i>{t('refresh')}</button>
        </div>
      </Match>
      <Match when={true}>
        <For each={props.shown} keyed={m => m.id}>{m => <InboxRow msg={m()} />}</For>
        {/* 搜索结果不分页，否则会把搜索结果顶掉 */}
        <Show when={!state.search.active && state.inbox.total > state.inbox.items.length}>
          <LoadMore id="btn-load-more" count={state.inbox.items.length} total={state.inbox.total} loading={state.inbox.loadingMore} onClick={loadMoreInbox} />
        </Show>
      </Match>
    </Switch>
  );
}

function InboxRow(props: { msg: Message }) {
  const id = () => props.msg.id;
  return (
    <div class={['card mb-2 mail-item', { 'mail-unread': !props.msg.seen, active: state.activeId === id() }]} data-msg-id={id()}>
      <div class="card-body py-2">
        <div class="d-flex align-items-start">
          <div class="form-check me-2 mt-1" onClick={e => e.stopPropagation()}>
            <input class="form-check-input mail-checkbox" type="checkbox" value={id()} checked={state.selected.includes(id())}
                   onChange={e => toggleSelected(id(), e.currentTarget.checked)} />
          </div>
          <div class="flex-grow-1 mail-item-body" onClick={() => viewMailDetail(id())}>
            <div class="d-flex justify-content-between align-items-start">
              <span class="mail-sender text-truncate me-2"><span class="mail-copy">{props.msg.from?.name || props.msg.from?.address || t('unknownSender')}</span></span>
              <div class="mail-item-meta text-end ms-2">
                <Show when={props.msg.extracted_code}>
                  {code => (
                    <button type="button" class="badge bg-success me-1 code-badge" title={t('copyCode')} onClick={e => copyText(code(), e)}>
                      <i class="bi bi-clipboard me-1"></i>{code()}
                    </button>
                  )}
                </Show>
                <small class="text-muted mail-time" title={fullDate(props.msg.createdAt)}>{shortDate(props.msg.createdAt)}</small>
              </div>
            </div>
            <div class="mail-subject text-truncate"><span class="mail-copy">{props.msg.subject || t('noSubject')}</span></div>
            <small class="mail-intro text-muted text-truncate d-block"><span class="mail-copy">{props.msg.intro || ''}</span></small>
          </div>
        </div>
      </div>
    </div>
  );
}

function FolderList(props: { folder: 'sent' | 'trash' }) {
  const list = () => state[props.folder];
  return (
    <Switch>
      <Match when={!state.email}><Hint text={t('queryFirst')} /></Match>
      <Match when={list().status === 'loading' || list().status === 'idle'}><Spinner text={t('loading')} /></Match>
      <Match when={list().status === 'error'}><ErrorState text={list().error} /></Match>
      <Match when={list().items.length === 0}>
        <div class="empty-state">
          <i class={`bi ${props.folder === 'sent' ? 'bi-send' : 'bi-trash'} d-block`}></i>
          <p>{props.folder === 'sent' ? t('noSentMail') : t('noTrashMail')}</p>
        </div>
      </Match>
      <Match when={true}>
        <Show when={props.folder === 'sent'} fallback={
          <For each={state.trash.items} keyed={m => m.id}>{m => <TrashRow msg={m()} />}</For>
        }>
          <For each={state.sent.items} keyed={m => m.id}>{m => <SentRow msg={m()} />}</For>
        </Show>
        <Show when={list().total > list().items.length}>
          <LoadMore count={list().items.length} total={list().total} loading={list().loadingMore} onClick={() => loadFolder(props.folder, true)} />
        </Show>
      </Match>
    </Switch>
  );
}

function SentRow(props: { msg: SentMessage }) {
  return (
    <div class={['card mb-2 mail-item', { active: state.activeId === props.msg.id }]} data-msg-id={props.msg.id} onClick={() => viewSentDetail(props.msg.id)}>
      <div class="card-body py-2">
        <div class="d-flex justify-content-between align-items-start">
          <strong><i class="bi bi-arrow-right me-1 text-muted"></i><span class="mail-copy">{(props.msg.to || []).join(', ')}</span></strong>
          <small class="text-muted mail-time" title={fullDate(props.msg.createdAt)}>{shortDate(props.msg.createdAt)}</small>
        </div>
        <div class="text-truncate"><span class="mail-copy">{props.msg.subject || t('noSubject')}</span></div>
      </div>
    </div>
  );
}

function TrashRow(props: { msg: Message }) {
  return (
    <div class={['card mb-2 mail-item', { active: state.activeId === props.msg.id }]} data-msg-id={props.msg.id} onClick={() => viewMailDetail(props.msg.id, true)}>
      <div class="card-body py-2">
        <div class="d-flex justify-content-between align-items-start">
          <span class="mail-sender text-truncate me-2"><span class="mail-copy">{props.msg.from?.name || props.msg.from?.address || t('unknownSender')}</span></span>
          <small class="text-muted mail-time" title={fullDate(props.msg.createdAt)}>{shortDate(props.msg.createdAt)}</small>
        </div>
        <div class="mail-subject text-truncate"><span class="mail-copy">{props.msg.subject || t('noSubject')}</span></div>
        <small class="mail-intro text-muted text-truncate d-block"><span class="mail-copy">{props.msg.intro || ''}</span></small>
      </div>
    </div>
  );
}
