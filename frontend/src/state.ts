// All main-UI state and the actions that change it. Components only read `state` and call
// these functions; nothing else writes to it.
//
// Requests race: every list/detail load takes a ticket and drops its reply if a newer load
// of the same kind started meanwhile, or if the mailbox changed (switching mailboxes,
// auto-refresh and manual queries can all be in flight at once).
import { createStore, flush } from 'solid-js';
import { errorText, getJSON, postJSON, type ListReply, type Message, type MessageDetail, type Reply, type SentMessage } from './api';
import { t } from './i18n';
import { showToast, toastError } from './ui';

export type Folder = 'inbox' | 'sent' | 'trash';
export type Tab = Folder | 'imap';
export const FOLDERS: Folder[] = ['inbox', 'sent', 'trash'];

export const PAGE_SIZE = 30;
const MAX_PAGE = 100; // pageArgs() in viewer.go caps limit at 100
const RECENT_KEY = 'manymail-recent';
const RECENT_MAX = 8;
const VIEW_KEY = 'manymail-view';
export const AUTO_REFRESH_INTERVAL = 15000;

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface ListState<T> { items: T[]; total: number; status: Status; error: string; loadingMore: boolean }

const emptyList = <T,>(): ListState<T> => ({ items: [], total: 0, status: 'idle', error: '', loadingMore: false });

export type Detail =
  | { kind: 'none' }
  | { kind: 'loading'; sent: boolean }
  | { kind: 'error'; message: string; alert: boolean }
  | { kind: 'mail'; id: string; trash: boolean; msg: MessageDetail }
  | { kind: 'sent'; id: string; msg: SentMessage };

export interface AppState {
  tab: Tab;
  lastFolder: Folder;
  domains: string[];
  domainsLoaded: boolean;
  domainsError: string;
  form: { domain: string; prefix: string };
  querying: boolean;
  queryError: string;
  recent: string[];
  email: string;
  inbox: ListState<Message>;
  sent: ListState<SentMessage>;
  trash: ListState<Message>;
  search: { input: string; active: boolean; status: Status; error: string; items: Message[] };
  selected: string[];
  activeId: string | null;
  detail: Detail;
  plainText: boolean;
  mobileDetail: boolean;
  autoRefresh: boolean;
}

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const [state, setState] = createStore<AppState>({
  tab: 'inbox',
  lastFolder: 'inbox',
  domains: [],
  domainsLoaded: false,
  domainsError: '',
  form: { domain: '', prefix: '' },
  querying: false,
  queryError: '',
  recent: loadRecent(),
  email: '',
  inbox: emptyList<Message>(),
  sent: emptyList<SentMessage>(),
  trash: emptyList<Message>(),
  search: { input: '', active: false, status: 'idle', error: '', items: [] },
  selected: [],
  activeId: null,
  detail: { kind: 'none' },
  plainText: false,
  mobileDetail: false,
  autoRefresh: false,
});

// Plain mirrors for code that runs right after a write: store reads only see a write after
// the microtask flush.
let currentEmail = '';
const tickets = { inbox: 0, sent: 0, trash: 0, detail: 0, search: 0 };
// Bumped by every local change to the inbox list; a silent refresh that started before one drops its reply.
let inboxEdits = 0;

// ---- 刷新后恢复视图：停在哪个 Tab、查的哪个邮箱、打开的哪封信（按标签页存，关了就清） ----
interface ViewState { tab?: string; folder?: string; email?: string; msg?: string | null }

function loadViewState(): ViewState {
  try {
    const s = JSON.parse(sessionStorage.getItem(VIEW_KEY) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function saveViewState(patch: ViewState) {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({ ...loadViewState(), ...patch }));
  } catch {}
}

// ---- 最近查询过的邮箱 ----
function saveRecent(list: string[]) {
  const next = list.slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
  setState(s => { s.recent = next; });
}

function rememberMailbox(email: string) {
  saveRecent([email, ...loadRecent().filter(x => x.toLowerCase() !== email.toLowerCase())]);
}

export const removeRecentMailbox = (email: string) => saveRecent(loadRecent().filter(x => x !== email));
export const clearRecentMailboxes = () => saveRecent([]);

// 域名列表还没加载完时不要误判为停用
export const isStaleMailbox = (email: string) => state.domains.length > 0 && !state.domains.includes(email.split('@')[1] || '');

export function closeLeftDrawer() {
  const el = document.getElementById('mail-left-column');
  if (el) bootstrap.Offcanvas.getInstance(el)?.hide();
}

export function useRecentMailbox(email: string) {
  const [prefix, domain] = email.split('@');
  setState(s => {
    if (s.domains.includes(domain)) s.form.domain = domain;
    s.form.prefix = prefix || '';
  });
  if (state.tab !== 'inbox') switchTab('inbox');
  closeLeftDrawer();
  flush(); // queryInbox reads the form just written
  return queryInbox();
}

// ---- 域名 ----
export async function loadDomains() {
  try {
    const data = await getJSON<Reply & { domains?: { domain: string; is_active: boolean }[] }>('/api/domains');
    if (!data.success) {
      setState(s => { s.domainsError = data.message || t('loadFailed'); });
      return;
    }
    const domains = (data.domains || []).filter(d => d.is_active).map(d => d.domain);
    setState(s => {
      s.domains = domains;
      s.domainsLoaded = true;
      s.domainsError = '';
      if (!domains.includes(s.form.domain)) s.form.domain = domains[0] || '';
    });
  } catch (e) {
    setState(s => { s.domainsError = t('loadFailed') + ': ' + errorText(e); });
  }
}

// ---- 详情 ----
export function showListView() {
  setState(s => { s.mobileDetail = false; });
}

export function resetMailDetail() {
  tickets.detail++;
  setState(s => {
    s.detail = { kind: 'none' };
    s.activeId = null;
    s.plainText = false;
    s.mobileDetail = false;
  });
  saveViewState({ msg: null });
}

function openDetailShell(id: string, sent: boolean) {
  saveViewState({ msg: id });
  setState(s => {
    s.activeId = id;
    s.mobileDetail = true;
    s.plainText = false;
    s.detail = { kind: 'loading', sent };
  });
  return ++tickets.detail;
}

export async function viewMailDetail(id: string, trash = false) {
  const email = currentEmail;
  if (!email) return;
  const ticket = openDetailShell(id, false);
  const current = () => ticket === tickets.detail && email === currentEmail;
  try {
    const data = await postJSON<Reply & { detail: MessageDetail }>('/api/inbox/detail', { email, message_id: id });
    if (!current()) return;
    if (!data.success) {
      setState(s => { s.detail = { kind: 'error', message: data.message || t('loadFailed'), alert: false }; });
      return;
    }
    if (!trash) inboxEdits++;
    setState(s => {
      s.detail = { kind: 'mail', id, trash, msg: data.detail };
      // 同步已读状态
      if (!trash) {
        const m = s.inbox.items.find(m => m.id === id);
        if (m) m.seen = true;
        const r = s.search.items.find(m => m.id === id);
        if (r) r.seen = true;
      }
    });
  } catch (e) {
    if (current()) setState(s => { s.detail = { kind: 'error', message: t('loadFailed') + ': ' + errorText(e), alert: true }; });
  }
}

export async function viewSentDetail(id: string) {
  const email = currentEmail;
  const listed = state.sent.items.find(m => m.id === id);
  if (!email || !listed) return;
  const ticket = openDetailShell(id, true);
  let msg: SentMessage = { ...listed };
  try {
    const data = await postJSON<Reply & { detail: SentMessage }>('/api/sent/detail', { email, message_id: id });
    if (data.success) msg = data.detail;
  } catch {
    // 详情接口挂了就用列表里的那份
  }
  if (ticket === tickets.detail && email === currentEmail) setState(s => { s.detail = { kind: 'sent', id, msg }; });
}

export const togglePlainText = () => setState(s => { s.plainText = !s.plainText; });

// ---- 收件箱 ----
function pruneSelection(s: AppState) {
  const visible = new Set((s.search.active ? s.search.items : s.inbox.items).map(m => m.id));
  s.selected = s.selected.filter(id => visible.has(id));
}

function mergeUnique<T extends { id: string }>(head: T[], tail: T[]): T[] {
  const seen = new Set(head.map(m => m.id));
  return head.concat(tail.filter(m => !seen.has(m.id)));
}

// Query the mailbox typed in the left panel. Errors there go to the panel; the list shows them too.
export async function queryInbox() {
  const prefix = state.form.prefix.trim();
  if (!prefix) {
    resetMailDetail();
    setState(s => { s.queryError = t('enterPrefixErr'); });
    return;
  }
  return loadInbox(`${prefix}@${state.form.domain}`);
}

async function loadInbox(email: string, silent = false) {
  if (!silent) resetMailDetail();
  const ticket = ++tickets.inbox;
  setState(s => {
    s.queryError = '';
    s.inbox.loadingMore = false;
    if (!silent) {
      s.querying = true;
      s.inbox.status = 'loading';
      s.selected = [];
    }
  });
  try {
    const data = await postJSON<ListReply<Message>>('/api/inbox/query', { email, offset: 0, limit: PAGE_SIZE });
    if (ticket !== tickets.inbox) return;
    if (!data.success) {
      if (!silent) setState(s => {
        s.queryError = data.message || '';
        s.inbox.status = 'error';
        s.inbox.error = data.message || t('queryFailed');
      });
      return;
    }
    const changed = email !== currentEmail;
    currentEmail = email;
    tickets.search++;
    saveViewState({ email });
    setState(s => {
      s.email = email;
      s.inbox = { items: data.messages, total: data.total || 0, status: 'ready', error: '', loadingMore: false };
      if (changed) {
        s.sent = emptyList<SentMessage>();
        s.trash = emptyList<Message>();
        s.selected = [];
      }
      s.search.active = false;
      s.search.items = [];
      if (!silent) s.selected = [];
    });
    if (!silent) {
      rememberMailbox(email);
      closeLeftDrawer();
    }
    if (changed && (state.tab === 'sent' || state.tab === 'trash')) loadFolder(state.tab);
  } catch (e) {
    if (ticket === tickets.inbox && !silent) setState(s => {
      s.queryError = t('networkError') + ': ' + errorText(e);
      s.inbox.status = 'error';
      s.inbox.error = t('networkError') + ': ' + errorText(e);
    });
  } finally {
    if (ticket === tickets.inbox && !silent) setState(s => { s.querying = false; });
  }
}

// Auto-refresh: re-read the window already on screen (up to 100) and keep what lies beyond it,
// so neither "load more" pages, checkboxes nor the open mail get lost.
export async function refreshInboxSilently() {
  const email = currentEmail;
  if (!email || state.search.active || state.inbox.status === 'loading' || state.inbox.loadingMore) return;
  const ticket = ++tickets.inbox;
  const edits = inboxEdits;
  const limit = Math.min(Math.max(state.inbox.items.length, PAGE_SIZE), MAX_PAGE);
  try {
    const data = await postJSON<ListReply<Message>>('/api/inbox/query', { email, offset: 0, limit });
    if (ticket !== tickets.inbox || edits !== inboxEdits || email !== currentEmail || !data.success || state.search.active) return;
    const fresh = data.messages;
    const older = olderThanWindow(state.inbox.items, fresh, limit, data.total);
    setState(s => {
      s.inbox.items = mergeUnique(fresh, older);
      s.inbox.total = data.total || 0;
      pruneSelection(s);
    });
  } catch {
    // 静默刷新失败不打扰
  }
}

// Loaded mail that a refresh of the first `limit` messages should keep: whatever lies beyond the
// window (new arrivals push it down). If the reply is the whole mailbox, nothing beyond it exists.
// Equal timestamps are kept (mergeUnique drops the ones that came back); with no usable date for
// the window's end everything is kept rather than dropping loaded pages.
export function olderThanWindow(loaded: Message[], fresh: Message[], limit: number, total: number | undefined): Message[] {
  if (fresh.length < limit || fresh.length >= (typeof total === 'number' ? total : Infinity)) return [];
  const edge = Date.parse(fresh[fresh.length - 1].createdAt || '');
  if (Number.isNaN(edge)) return loaded;
  return loaded.filter(m => {
    const d = Date.parse(m.createdAt || '');
    return Number.isNaN(d) || d <= edge;
  });
}

export async function loadMoreInbox() {
  const email = currentEmail;
  if (!email || state.inbox.loadingMore) return;
  const ticket = ++tickets.inbox;
  setState(s => { s.inbox.loadingMore = true; });
  try {
    const data = await postJSON<ListReply<Message>>('/api/inbox/query', { email, offset: state.inbox.items.length, limit: PAGE_SIZE });
    if (ticket !== tickets.inbox || email !== currentEmail) return;
    if (data.success) {
      setState(s => {
        s.inbox.items = mergeUnique(s.inbox.items, data.messages);
        s.inbox.total = data.total || 0;
      });
    } else {
      toastError(data.message || t('loadFailed'));
    }
  } catch (e) {
    if (ticket === tickets.inbox) toastError(t('networkError') + ': ' + errorText(e));
  } finally {
    if (ticket === tickets.inbox) setState(s => { s.inbox.loadingMore = false; });
  }
}

export const reloadInbox = () => (currentEmail ? loadInbox(currentEmail) : undefined);

// ---- 搜索 ----
export async function searchMail() {
  const email = currentEmail;
  if (!email) return;
  const query = state.search.input.trim();
  if (!query) return clearSearch();
  const ticket = ++tickets.search;
  setState(s => {
    s.search.active = true;
    s.search.status = 'loading';
    s.search.items = [];
    s.selected = [];
  });
  try {
    const data = await postJSON<ListReply<Message>>('/api/inbox/search', { email, query });
    if (ticket !== tickets.search || email !== currentEmail) return;
    setState(s => {
      if (data.success) {
        s.search.status = 'ready';
        s.search.items = data.messages;
      } else {
        s.search.status = 'error';
        s.search.error = data.message || t('searchFailed');
      }
    });
  } catch (e) {
    if (ticket === tickets.search) setState(s => {
      s.search.status = 'error';
      s.search.error = t('searchFailed') + ': ' + errorText(e);
    });
  }
}

export function clearSearch() {
  tickets.search++;
  setState(s => {
    s.search.input = '';
    s.search.active = false;
    s.search.items = [];
    s.selected = [];
  });
}

// ---- 已发送 / 回收站 ----
export async function loadFolder(folder: 'sent' | 'trash', append = false) {
  const email = currentEmail;
  if (!email) return;
  const ticket = ++tickets[folder];
  const offset = append ? state[folder].items.length : 0;
  setState(s => {
    if (append) s[folder].loadingMore = true;
    else s[folder].status = 'loading';
  });
  try {
    const data = await postJSON<ListReply<Message & SentMessage>>(`/api/${folder}/query`, { email, offset, limit: PAGE_SIZE });
    if (ticket !== tickets[folder] || email !== currentEmail) return;
    setState(s => {
      const list = s[folder];
      list.loadingMore = false;
      if (!data.success) {
        if (append) toastError(data.message || t('loadFailed'));
        else {
          list.status = 'error';
          list.error = data.message || t('loadFailed');
        }
        return;
      }
      list.items = append ? mergeUnique(list.items, data.messages) : data.messages;
      list.total = data.total || data.messages.length;
      list.status = 'ready';
    });
  } catch (e) {
    if (ticket !== tickets[folder]) return;
    setState(s => {
      s[folder].loadingMore = false;
      if (!append) {
        s[folder].status = 'error';
        s[folder].error = t('loadFailed') + ': ' + errorText(e);
      }
    });
  }
}

// ---- Tab 切换 ----
export function switchTab(tab: Tab) {
  const folder = (FOLDERS as string[]).includes(tab) ? (tab as Folder) : state.lastFolder;
  saveViewState({ tab, folder });
  tickets.search++;
  setState(s => {
    s.tab = tab;
    s.lastFolder = folder;
    // 自动刷新只服务收件箱，切走就关掉，否则收件箱刷新会顶掉当前列表
    if (tab !== 'inbox') s.autoRefresh = false;
    if (tab !== 'inbox') s.search.input = '';
    s.search.active = false;
    s.search.items = [];
    s.selected = [];
    s.mobileDetail = false;
  });
  if (tab === 'imap') return Promise.resolve();
  resetMailDetail();
  if (!currentEmail) return Promise.resolve();
  // A load already in flight is for the mailbox just queried; starting another for currentEmail
  // (still the previous mailbox) would drop it.
  if (tab === 'inbox') return state.inbox.status === 'ready' || state.inbox.status === 'loading' ? Promise.resolve() : loadInbox(currentEmail);
  return loadFolder(tab);
}

export function setAutoRefresh(on: boolean) {
  setState(s => { s.autoRefresh = on && s.tab === 'inbox' && Boolean(s.email); });
}

// ---- 勾选与批量操作 ----
export function toggleSelected(id: string, on: boolean) {
  setState(s => {
    s.selected = on ? [...s.selected.filter(x => x !== id), id] : s.selected.filter(x => x !== id);
  });
}

export function setAllSelected(ids: string[], on: boolean) {
  setState(s => { s.selected = on ? [...ids] : []; });
}

const byNewest = (a: Message, b: Message) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();

function removeFromInbox(ids: string[]) {
  inboxEdits++;
  setState(s => {
    s.inbox.items = s.inbox.items.filter(m => !ids.includes(m.id));
    s.inbox.total = Math.max(0, s.inbox.total - ids.length);
    s.search.items = s.search.items.filter(m => !ids.includes(m.id));
    pruneSelection(s);
  });
}

function putBackIntoInbox(email: string, removed: Message[]) {
  if (email !== currentEmail) return;
  inboxEdits++;
  setState(s => {
    s.inbox.items = mergeUnique(s.inbox.items, removed).sort(byNewest);
    s.inbox.total += removed.length;
  });
  showToast(t('mailRestored'), { type: 'success' });
}

const batchRequest = (email: string, action: string, ids: string[]) =>
  postJSON<Reply>('/api/inbox/batch', { email, action, message_ids: ids });

export async function batchAction(action: 'delete' | 'mark_read') {
  const email = currentEmail;
  const ids = [...state.selected];
  if (!email || ids.length === 0) return;
  try {
    const data = await batchRequest(email, action, ids);
    if (!data.success) {
      toastError(data.message || t('deleteFailed'));
      return;
    }
    if (email !== currentEmail) return;
    if (action === 'delete') {
      // 直接删（软删除），用 Toast 给撤销入口，省掉每次确认弹窗
      const pool = state.search.active ? state.search.items : state.inbox.items;
      const removed = pool.filter(m => ids.includes(m.id)).map(m => ({ ...m }));
      removeFromInbox(ids);
      resetMailDetail();
      showToast(t('mailsDeleted', { n: ids.length }), {
        actionLabel: t('undo'),
        onAction: async () => {
          // 撤销批量删除走一次 batch restore；失败就引导去回收站
          try {
            const r = await batchRequest(email, 'restore', removed.map(m => m.id));
            if (r.success) putBackIntoInbox(email, removed);
            else toastError(t('undoFailed'));
          } catch {
            toastError(t('undoFailed'));
          }
        },
      });
    } else {
      inboxEdits++;
      setState(s => {
        for (const m of s.inbox.items) if (ids.includes(m.id)) m.seen = true;
        for (const m of s.search.items) if (ids.includes(m.id)) m.seen = true;
        s.selected = [];
      });
      showToast(t('markedRead'), { type: 'success' });
    }
  } catch (e) {
    toastError(t('networkError') + ': ' + errorText(e));
  }
}

// ---- 单封删除 / 恢复 ----
export async function deleteEmail(id: string) {
  const email = currentEmail;
  if (!email) return;
  try {
    const data = await postJSON<Reply>('/api/inbox/delete', { email, message_id: id });
    if (!data.success) {
      toastError(data.message || t('deleteFailed'));
      return;
    }
    if (email !== currentEmail) return;
    const found = state.inbox.items.find(m => m.id === id) || state.search.items.find(m => m.id === id);
    const removed = found ? { ...found } : null;
    removeFromInbox([id]);
    resetMailDetail();
    showToast(t('mailDeleted'), removed ? {
      actionLabel: t('undo'),
      onAction: async () => {
        try {
          const r = await postJSON<Reply>('/api/inbox/restore', { email, message_id: id });
          if (r.success) putBackIntoInbox(email, [removed]);
          else toastError(t('undoFailed'));
        } catch {
          toastError(t('undoFailed'));
        }
      },
    } : {});
  } catch (e) {
    toastError(t('networkError') + ': ' + errorText(e));
  }
}

export async function trashAction(url: string, id: string, okMessage: string) {
  const email = currentEmail;
  if (!email) return;
  try {
    const data = await postJSON<Reply>(url, { email, message_id: id });
    if (!data.success) {
      toastError(data.message || t('deleteFailed'));
      return;
    }
    if (email !== currentEmail) return;
    setState(s => {
      s.trash.items = s.trash.items.filter(m => m.id !== id);
      s.trash.total = Math.max(0, s.trash.total - 1);
      // 恢复的邮件回到收件箱，下次切过去重新拉
      s.inbox.status = 'idle';
    });
    resetMailDetail();
    showToast(okMessage, { type: 'success' });
  } catch (e) {
    toastError(t('networkError') + ': ' + errorText(e));
  }
}

export const restoreEmail = (id: string) => trashAction('/api/inbox/restore', id, t('mailRestored'));

// ---- 刷新按钮 ----
export function refreshCurrentTab(reloadImap: () => void) {
  if (state.tab === 'inbox') return reloadInbox();
  if (state.tab === 'imap') return reloadImap();
  return loadFolder(state.tab);
}

// ---- 启动：域名加载完再恢复上次的视图 ----
export async function restoreViewState() {
  // 先整份读出来：下面的查询和切换会顺手把 msg 清掉
  const { tab, folder, email, msg } = loadViewState();
  if ((FOLDERS as string[]).includes(folder || '')) setState(s => { s.lastFolder = folder as Folder; });
  flush(); // switchTab('imap') below reads lastFolder
  if (tab === 'imap') switchTab('imap');

  const [prefix, domain] = typeof email === 'string' ? email.split('@') : [];
  if (prefix && state.domains.includes(domain)) {
    setState(s => {
      s.form.domain = domain;
      s.form.prefix = prefix;
    });
    // IMAP 下在后台静默查，切回「邮件」时列表已经在了
    await loadInbox(`${prefix}@${domain}`, tab === 'imap');
  }
  if (tab === 'imap' || !currentEmail) return;
  if (tab === 'sent' || tab === 'trash') await switchTab(tab);
  flush();
  if (!msg || state.tab !== (tab || 'inbox')) return;
  if (state.tab === 'sent') {
    if (state.sent.items.some(m => m.id === msg)) await viewSentDetail(msg);
  } else if (state[state.tab as 'inbox' | 'trash'].items.some(m => m.id === msg)) {
    await viewMailDetail(msg, state.tab === 'trash');
  }
}

export const mailboxEmail = () => currentEmail;
