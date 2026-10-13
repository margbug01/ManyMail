// 经 mail-viewer 的 /imap/ 代理访问时接口要带 /imap 前缀。以前靠代理改写页面里的内联脚本，
// 拆成独立文件后代理只改写 HTML、改写不到这里，所以按当前路径自己补
var API_PREFIX = location.pathname.indexOf('/imap/') === 0 ? '/imap' : '';

let activeAccountId = null;
let activeFolder = 'INBOX';

// 刷新后回到原来的账号 / 文件夹 / 邮件（按标签页存，关了就清）
var IMAP_VIEW_KEY = 'manymail-imap-view';
function loadImapView() {
  try {
    var s = JSON.parse(sessionStorage.getItem(IMAP_VIEW_KEY) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch (e) { return {}; }
}
function saveImapView(patch) {
  try { sessionStorage.setItem(IMAP_VIEW_KEY, JSON.stringify(Object.assign(loadImapView(), patch))); } catch (e) {}
}
// 必须在初始化前读出来：applyLang() 会同步调 resetMailDetail() 把 uid 清掉
var pendingImapView = loadImapView();
let mailCache = [];
let hasMore = false;
let oldestSeq = null;
let detailVisible = false;
let selectMode = false;
let selectedUids = new Set();
let folderCache = [];
let folderUnseen = {};
let accountCache = [];

// === 列表缓存：先画上次的结果，后台再拉最新的（远端 IMAP 一个往返就要近 300ms） ===
var IMAP_CACHE_KEY = 'manymail-imap-cache';
var LIST_CACHE_MAX = 24;
var listCache = {};         // '账号|文件夹' -> { mails, hasMore, oldestSeq, total, unseen }
var foldersByAccount = {};  // 账号 -> 可选文件夹
var unseenByAccount = {};   // 账号 -> { 文件夹: 未读数 }
var listInflight = {};      // 同一个列表的并发请求共用一个
var loadSeq = 0;            // 只认最后一次 loadMails 的结果
var mailCacheKey = null;    // 当前 mailCache 属于哪个列表；搜索结果为 null，不写回缓存
var persistTimer = null;

(function restoreImapCache() {
  try {
    var c = JSON.parse(sessionStorage.getItem(IMAP_CACHE_KEY) || '{}') || {};
    listCache = c.lists || {};
    foldersByAccount = c.folders || {};
    unseenByAccount = c.unseen || {};
  } catch (e) {}
})();

function persistImapCache() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(function() {
    var keys = Object.keys(listCache);
    keys.slice(0, Math.max(0, keys.length - LIST_CACHE_MAX)).forEach(function(k) { delete listCache[k]; });
    try {
      sessionStorage.setItem(IMAP_CACHE_KEY, JSON.stringify({ lists: listCache, folders: foldersByAccount, unseen: unseenByAccount }));
    } catch (e) {}
  }, 300);
}

// 用邮箱地址当缓存键：服务端重启后账号 id 会按顺序重新分配，id 不可靠
function acctKey(accountId) {
  var email = accountEmail(accountId);
  return email ? email.toLowerCase() : 'id:' + accountId;
}

function listKey(accountId, folder) {
  return acctKey(accountId) + '|' + folder;
}

function putListCache(key, entry) {
  delete listCache[key];  // 挪到末尾，超量时先丢最久没用的
  listCache[key] = entry;
  persistImapCache();
}

function fetchMailList(accountId, folder) {
  var key = listKey(accountId, folder);
  if (!listInflight[key]) {
    listInflight[key] = api('GET', '/api/accounts/' + accountId + '/mails?folder=' + encodeURIComponent(folder) + '&count=30')
      .then(function(data) {
        var mails = data.mails || [];
        var entry = {
          mails: mails,
          hasMore: data.hasMore,
          oldestSeq: mails.length ? Math.min.apply(null, mails.map(function(m) { return m.seq; })) : null,
          total: data.total,
          unseen: data.unseen,
        };
        putListCache(key, entry);
        return entry;
      })
      .finally(function() { delete listInflight[key]; });
  }
  return listInflight[key];
}

function listSummary(entry, accountId, folder) {
  var fresh = (unseenByAccount[acctKey(accountId)] || {})[folder];
  var unseen = fresh != null ? fresh : entry.unseen;
  return unseen != null ? t('infoSummary', { total: entry.total, unseen: unseen }) : t('infoTotal', { total: entry.total });
}

function forgetAccountCache(accountId) {
  var prefix = acctKey(accountId) + '|';
  Object.keys(listCache).forEach(function(k) { if (k.indexOf(prefix) === 0) delete listCache[k]; });
  delete foldersByAccount[acctKey(accountId)];
  delete unseenByAccount[acctKey(accountId)];
  persistImapCache();
}

const LANGS = {
  zh: {
    brandTitle: 'ManyMail',
    accountSection: '邮箱账户',
    folderSection: '文件夹',
    moreFolders: '更多',
    addAccount: '添加邮箱',
    batchImport: '批量导入',
    searchPlaceholder: '搜索发件人 / 主题...',
    searchButton: '搜索邮件',
    refreshButton: '刷新列表',
    modalTitle: '连接 IMAP 邮箱',
    singleTab: '单个连接',
    presetLabel: '邮箱类型',
    loading: '加载中...',
    hostLabel: 'IMAP 服务器',
    portLabel: '端口',
    emailLabel: '邮箱地址',
    passwordLabel: '密码 / 应用专用密码',
    passwordPlaceholder: '密码',
    cancel: '取消',
    connectButton: '连接邮箱',
    batchLabel: '账户列表（每行一个，格式: 邮箱:密码）',
    batchHint: '每个邮箱都会自动识别 IMAP 服务器：常见邮箱、Thunderbird 服务商数据库、域名 MX 记录，最后再试 imap. / mail. 主机名',
    autoPreset: '自动识别（推荐）',
    detecting: '正在识别服务器...',
    detected: '已识别：{host}:{port}',
    detectFailed: '没能自动识别，请填写 IMAP 服务器',
    editServer: '修改',
    startImport: '开始导入',
    emptyAccountsTitle: '还没有连接邮箱',
    emptyAccountsDesc: '添加一个 IMAP 邮箱后，即可在 ManyMail 中统一浏览邮件。',
    emptyDetailTitle: '请选择一封邮件',
    emptyDetailDesc: '在左侧选择邮件后，可在这里查看正文、附件与收发件信息。',
    noMailsTitle: '这里还没有邮件',
    noMailsDesc: '可以切换文件夹，或者点击刷新查看最新内容。',
    searching: '搜索中...',
    loadMore: '加载更多',
    retryLoadMore: '加载失败，点击重试',
    backToList: '返回邮件列表',
    attachments: '附件',
    from: '发件人',
    to: '收件人',
    cc: '抄送',
    date: '日期',
    fillCredentials: '请填写邮箱地址和密码',
    importRequired: '请输入账户列表',
    importSuccess: '成功',
    copiedPrefix: '已复制：',
    infoSummary: '共 {total} 封 / 未读 {unseen} 封',
    infoTotal: '共 {total} 封',
    searchSummary: '搜索结果：共 {count} 封',
    importing: '正在导入 {count} 个账户...',
    importDone: '导入完成：成功 {success} / 共 {total}',
    disconnectTitle: '断开',
    disconnectConfirm: '确定断开 {email} 吗？之后需要重新添加才能查看。',
    copyEmailTitle: '复制邮箱',
    customPreset: '自定义',
    markRead: '标记已读',
    markUnread: '标记未读',
    star: '星标',
    unstar: '取消星标',
    deleteButton: '删除',
    deleteConfirm: '确定要永久删除这封邮件吗？',
    moveToTrash: '移到回收站',
    moveToFolder: '移动到...',
    selectMode: '多选',
    exitSelectMode: '退出多选',
    selectAll: '全选',
    deselectAll: '取消',
    batchDelete: '删除',
    batchRead: '已读',
    batchUnread: '未读',
    batchStar: '星标',
    batchMove: '移动',
    batchConfirmDelete: '确定要删除选中的 {n} 封邮件吗？',
    searchSubject: '主题',
    searchFrom: '发件人',
    searchBody: '正文',
    searchAll: '全部',
    operationFailed: '操作失败',
  },
  en: {
    brandTitle: 'ManyMail',
    accountSection: 'Accounts',
    folderSection: 'Folders',
    moreFolders: 'More',
    addAccount: 'Add account',
    batchImport: 'Batch import',
    searchPlaceholder: 'Search sender / subject...',
    searchButton: 'Search mail',
    refreshButton: 'Refresh list',
    modalTitle: 'Connect IMAP mailbox',
    singleTab: 'Single account',
    presetLabel: 'Mailbox type',
    loading: 'Loading...',
    hostLabel: 'IMAP server',
    portLabel: 'Port',
    emailLabel: 'Email address',
    passwordLabel: 'Password / app password',
    passwordPlaceholder: 'Password',
    cancel: 'Cancel',
    connectButton: 'Connect mailbox',
    batchLabel: 'Accounts (one per line, format: email:password)',
    batchHint: 'IMAP servers are detected for every address: known providers, the Thunderbird ISP database, domain MX records, then imap. / mail. host names.',
    autoPreset: 'Auto-detect (recommended)',
    detecting: 'Detecting server...',
    detected: 'Detected: {host}:{port}',
    detectFailed: 'Could not detect the server, please enter it',
    editServer: 'Edit',
    startImport: 'Start import',
    emptyAccountsTitle: 'No mailbox connected yet',
    emptyAccountsDesc: 'Add an IMAP mailbox to browse everything inside ManyMail.',
    emptyDetailTitle: 'Select an email',
    emptyDetailDesc: 'Choose an email from the left to view its body, attachments, and delivery details here.',
    noMailsTitle: 'No mail here yet',
    noMailsDesc: 'Try another folder, or refresh to check for the latest messages.',
    searching: 'Searching...',
    loadMore: 'Load more',
    retryLoadMore: 'Load failed, click to retry',
    backToList: 'Back to list',
    attachments: 'Attachments',
    from: 'From',
    to: 'To',
    cc: 'Cc',
    date: 'Date',
    fillCredentials: 'Please enter both email address and password',
    importRequired: 'Please enter the account list',
    importSuccess: 'Success',
    copiedPrefix: 'Copied: ',
    infoSummary: '{total} total / {unseen} unread',
    infoTotal: '{total} total',
    searchSummary: 'Search results: {count}',
    importing: 'Importing {count} accounts...',
    importDone: 'Import complete: {success} succeeded / {total} total',
    disconnectTitle: 'Disconnect',
    disconnectConfirm: 'Disconnect {email}? You will need to add it again to read its mail.',
    copyEmailTitle: 'Copy email',
    customPreset: 'Custom',
    markRead: 'Mark read',
    markUnread: 'Mark unread',
    star: 'Star',
    unstar: 'Unstar',
    deleteButton: 'Delete',
    deleteConfirm: 'Permanently delete this email?',
    moveToTrash: 'Move to Trash',
    moveToFolder: 'Move to...',
    selectMode: 'Select',
    exitSelectMode: 'Cancel',
    selectAll: 'All',
    deselectAll: 'None',
    batchDelete: 'Delete',
    batchRead: 'Read',
    batchUnread: 'Unread',
    batchStar: 'Star',
    batchMove: 'Move',
    batchConfirmDelete: 'Delete {n} selected emails?',
    searchSubject: 'Subject',
    searchFrom: 'From',
    searchBody: 'Body',
    searchAll: 'All',
    operationFailed: 'Operation failed',
  }
};
let currentLang = ManyMailI18n.detect();
let currentDict = ManyMailI18n.dict(currentLang, 'imap', LANGS);

function t(key, vars) {
  let s = currentDict[key] || LANGS.zh[key] || key;
  if (vars) {
    Object.keys(vars).forEach(function(k) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    });
  }
  return s;
}

function richEmpty(titleKey, descKey) {
  return '<strong>' + esc(t(titleKey)) + '</strong><span>' + esc(t(descKey)) + '</span>';
}

function refreshStaticText() {
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
  document.documentElement.lang = ManyMailI18n.locale(currentLang);
}

function setLang(code) {
  currentLang = ManyMailI18n.normalize(code) || currentLang;
  currentDict = ManyMailI18n.dict(currentLang, 'imap', LANGS);
  ManyMailI18n.save(currentLang);
  applyLang();
}

function applyLang() {
  refreshStaticText();
  if (activeAccountId) {
    loadAccounts();
    renderFolders();
    updateMobileContext();
  }
  if (!activeAccountId) {
    document.getElementById('mail-list').innerHTML = '<div class="detail-empty">' + richEmpty('emptyAccountsTitle', 'emptyAccountsDesc') + '</div>';
  } else if (mailCache.length === 0) {
    renderMailList(mailCache);
  } else {
    renderMailList(mailCache);
  }
  if (!detailVisible) {
    resetMailDetail();
  } else if (selectedMailIndex >= 0 && mailCache[selectedMailIndex]) {
    readMail(selectedMailIndex);
  }
  document.getElementById('m-preset').querySelectorAll('option[data-i18n]').forEach(function(opt) {
    opt.textContent = t(opt.dataset.i18n);
  });
}

window.addEventListener('message', function(event) {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === 'manymail-lang-change' && event.data.lang) {
    setLang(event.data.lang);
  }
});

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_PREFIX + url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// === 账户 ===
async function loadAccounts() {
  const list = await api('GET', '/api/accounts');
  const el = document.getElementById('account-list');
  if (list.length === 0) { el.innerHTML = ''; return; }
  accountCache = list;
  el.innerHTML = list.map(function(a) {
    var at = a.email.lastIndexOf('@');
    var local = at > 0 ? a.email.slice(0, at) : a.email;
    var domain = at > 0 ? a.email.slice(at) : '';
    var id = Number(a.id);
    return '<div class="account-item' + (a.id === activeAccountId ? ' active' : '') + '" data-email="' + esc(a.email) + '" title="' + esc(a.email) + '" onclick="selectAccount(' + id + ')">' +
      '<span class="account-avatar">' + esc(local.charAt(0)) + '</span>' +
      '<span class="account-name"><span class="account-local">' + esc(local) + '</span><span class="account-domain">' + esc(domain) + '</span></span>' +
      '<span class="account-actions">' +
        '<button type="button" class="account-action" onclick="copyAccountEmail(' + id + ', event)" title="' + esc(t('copyEmailTitle')) + '" aria-label="' + esc(t('copyEmailTitle')) + '"><i class="bi bi-clipboard"></i></button>' +
        '<button type="button" class="account-action danger" onclick="event.stopPropagation();removeAccount(' + id + ')" title="' + esc(t('disconnectTitle')) + '" aria-label="' + esc(t('disconnectTitle')) + '"><i class="bi bi-box-arrow-right"></i></button>' +
      '</span>' +
    '</div>';
  }).join('');
  updateMobileContext();
}

async function selectAccount(id) {
  activeAccountId = id;
  activeFolder = 'INBOX';
  saveImapView({ account: id, folder: 'INBOX', uid: null });
  detailVisible = false;
  syncResponsiveView();
  loadAccounts();
  loadFolders(id);
  loadMails();
}

function accountEmail(id) {
  var account = accountCache.find(function(a) { return a.id === id; });
  return account ? account.email : '';
}

function copyAccountEmail(id, event) {
  copyEmail(accountEmail(id), event);
}

async function removeAccount(id) {
  if (!confirm(t('disconnectConfirm', { email: accountEmail(id) }))) return;
  await api('DELETE', '/api/accounts/' + id);
  forgetAccountCache(id);
  if (activeAccountId === id) {
    activeAccountId = null;
    saveImapView({ account: null, folder: 'INBOX', uid: null });
    document.getElementById('folder-section').style.display = 'none';
    document.getElementById('mail-list').innerHTML = '<div class="detail-empty">' + richEmpty('emptyAccountsTitle', 'emptyAccountsDesc') + '</div>';
    resetMailDetail();
    setMailInfo('');
  }
  loadAccounts();
}

// === 文件夹 ===
async function loadFolders(id) {
  var key = acctKey(id);
  // 有缓存先画，未读角标也先用上次的
  folderUnseen = unseenByAccount[key] || {};
  if (foldersByAccount[key]) {
    folderCache = foldersByAccount[key];
    document.getElementById('folder-section').style.display = 'flex';
    renderFolders();
  }
  loadFolderStatus(id);
  const folders = await api('GET', '/api/accounts/' + id + '/folders');
  const selectable = folders.filter(f => !f.noselect);
  foldersByAccount[key] = selectable;
  persistImapCache();
  if (id !== activeAccountId) return;
  folderCache = selectable;
  document.getElementById('folder-section').style.display = 'flex';
  renderFolders();
}

// 文件夹按钮放不下时，竖向滚轮直接横向滚动
document.addEventListener('DOMContentLoaded', function() {
  var bar = document.getElementById('folder-section');
  if (!bar) return;
  bar.addEventListener('wheel', function(e) {
    if (bar.scrollWidth <= bar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    bar.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
});

// 主按钮组固定三个：收件箱 / 已发送 / 回收站（各取第一个匹配的），其余进「更多」菜单
var PRIMARY_FOLDERS = [['收件箱'], ['已发送'], ['回收站', '已删除']];

function folderButtonInner(f, withBadge) {
  var unseen = folderUnseen[f.path] || 0;
  return '<i class="bi ' + folderIcon(f.name) + '"></i>' +
    '<span class="folder-name">' + esc(translateFolder(f.name)) + '</span>' +
    (withBadge && unseen > 0 ? '<span class="folder-badge">' + (unseen > 999 ? '999+' : unseen) + '</span>' : '');
}

function renderFolders() {
  var primary = [], rest = [];
  PRIMARY_FOLDERS.forEach(function(names) {
    var idx = folderCache.findIndex(function(f) {
      var key = folderKey(f.name);
      return key && names.indexOf(FOLDER_ZH[key]) >= 0 && primary.indexOf(folderCache.indexOf(f)) < 0;
    });
    if (idx >= 0) primary.push(idx);
  });
  folderCache.forEach(function(f, i) { if (primary.indexOf(i) < 0) rest.push(i); });

  var html = primary.map(function(i) {
    var f = folderCache[i], on = f.path === activeFolder;
    return '<button type="button" class="folder-item' + (on ? ' active' : '') + '" aria-pressed="' + on + '" onclick="selectFolder(folderCache[' + i + '].path)">' +
      folderButtonInner(f, true) + '</button>';
  }).join('');

  if (rest.length) {
    var activeRest = rest.filter(function(i) { return folderCache[i].path === activeFolder; })[0];
    // 当前停在菜单里的文件夹时，「更多」按钮变成选中态并显示它的名字
    var label = activeRest !== undefined ? folderButtonInner(folderCache[activeRest], true)
      : '<i class="bi bi-three-dots"></i><span class="folder-name">' + esc(t('moreFolders')) + '</span>';
    html += '<div class="folder-more" id="folder-more">' +
      '<button type="button" class="folder-item' + (activeRest !== undefined ? ' active' : '') + '" aria-haspopup="true" aria-expanded="false" onclick="toggleFolderMenu(event)">' +
        label + '<i class="bi bi-chevron-down"></i></button>' +
      '<div class="folder-menu" role="menu">' + rest.map(function(i) {
        var f = folderCache[i], on = f.path === activeFolder;
        return '<button type="button" role="menuitem" class="folder-menu-item' + (on ? ' active' : '') + '" onclick="selectFolder(folderCache[' + i + '].path)">' +
          folderButtonInner(f, true) + '</button>';
      }).join('') + '</div></div>';
  }
  document.getElementById('folder-list').innerHTML = html;
}

function toggleFolderMenu(event, open) {
  if (event) event.stopPropagation();
  var more = document.getElementById('folder-more');
  if (!more) return;
  var next = open === undefined ? !more.classList.contains('open') : open;
  more.classList.toggle('open', next);
  more.querySelector('button').setAttribute('aria-expanded', String(next));
}

document.addEventListener('click', function(e) {
  if (!e.target.closest || !e.target.closest('#folder-more')) toggleFolderMenu(null, false);
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') toggleFolderMenu(null, false);
});

async function loadFolderStatus(id) {
  try {
    var statuses = await api('GET', '/api/accounts/' + id + '/folders/status');
    var map = {};
    statuses.forEach(function(s) { map[s.path] = s.unseen; });
    unseenByAccount[acctKey(id)] = map;
    persistImapCache();
    if (id !== activeAccountId) return;
    folderUnseen = map;
    renderFolders();
    // 邮件列表接口不再带实时未读数，这里拿到后顺手刷新顶部计数
    var entry = listCache[listKey(id, activeFolder)];
    if (entry && mailCacheKey === listKey(id, activeFolder)) setMailInfo(listSummary(entry, id, activeFolder));
  } catch (e) {}
}

function selectFolder(path) {
  activeFolder = path;
  saveImapView({ folder: path, uid: null });
  detailVisible = false;
  syncResponsiveView();
  // 文件夹结构没变，只换高亮；未读数后台刷新
  renderFolders();
  loadFolderStatus(activeAccountId);
  loadMails();
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 991.98px)').matches;
}

function setMobileNavigation(open) {
  const app = document.querySelector('.app');
  const expanded = Boolean(open && isMobileLayout());
  const wasOpen = app.classList.contains('mobile-nav-open');
  app.classList.toggle('mobile-nav-open', expanded);
  document.getElementById('mobile-nav-toggle').setAttribute('aria-expanded', String(expanded));
  document.querySelector('.main').inert = expanded;
  if (expanded) document.querySelector('.mobile-nav-close').focus();
  else if (wasOpen && isMobileLayout() && !detailVisible) document.getElementById('mobile-nav-toggle').focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setMobileNavigation(false);
});

function syncResponsiveView() {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('mobile-view-detail', isMobileLayout() && detailVisible);
  app.classList.toggle('mobile-view-list', isMobileLayout() && !detailVisible);
  setMobileNavigation(false);
  updateMobileContext();
}

function updateMobileContext() {
  const selectedAccount = document.querySelector('.account-item.active');
  document.getElementById('mobile-mail-context').textContent =
    translateFolder(activeFolder || 'INBOX') +
    (selectedAccount && selectedAccount.dataset.email ? ' · ' + selectedAccount.dataset.email : '');
}

function setMailInfo(text) {
  document.getElementById('mail-info').textContent = text;
  document.getElementById('mobile-mail-info').textContent = text;
}

function resetMailDetail(message) {
  detailVisible = false;
  saveImapView({ uid: null });
  document.getElementById('mail-detail').innerHTML = '<div class="detail-empty">' + (message || richEmpty('emptyDetailTitle', 'emptyDetailDesc')) + '</div>';
  syncResponsiveView();
}

function showMailListView() {
  detailVisible = false;
  saveImapView({ uid: null });
  syncResponsiveView();
}

// === 邮件列表 ===
async function loadMails() {
  if (!activeAccountId) return;
  detailVisible = false;
  syncResponsiveView();
  var accountId = activeAccountId, folder = activeFolder;
  var key = listKey(accountId, folder);
  var seq = ++loadSeq;
  var cached = listCache[key];
  const el = document.getElementById('mail-list');
  if (cached) {
    applyMailList(key, cached, accountId, folder, true);
  } else {
    mailCacheKey = null;
    el.innerHTML = '<div class="loading">' + t('loading') + '</div>';
  }
  try {
    var fresh = await fetchMailList(accountId, folder);
    if (seq !== loadSeq) return;  // 期间切去了别的账号/文件夹
    // 内容没变就不重画，免得列表闪一下
    if (cached && mailCacheKey === key && JSON.stringify(fresh.mails) === JSON.stringify(mailCache.slice(0, fresh.mails.length)) && fresh.total === cached.total) {
      setMailInfo(listSummary(fresh, accountId, folder));
      return;
    }
    applyMailList(key, fresh, accountId, folder, true);
  } catch (err) {
    if (seq !== loadSeq) return;
    if (!cached) el.innerHTML = '<div class="detail-empty">' + esc(err.message) + '</div>';
  }
}

function applyMailList(key, entry, accountId, folder, keepSelection) {
  // 后台刷新回来时按 uid 保住当前选中的那封
  var selectedUid = keepSelection && mailCacheKey === key && mailCache[selectedMailIndex] ? mailCache[selectedMailIndex].uid : null;
  mailCacheKey = key;
  mailCache = entry.mails.slice();
  hasMore = entry.hasMore;
  oldestSeq = entry.oldestSeq;
  selectedMailIndex = selectedUid == null ? -1 : mailCache.findIndex(function(m) { return m.uid === selectedUid; });
  setMailInfo(listSummary(entry, accountId, folder));
  renderMailList(mailCache);
}

// 列表在本地被改过（已读、星标、删除、加载更多）就写回缓存，下次直接用
function syncListCache() {
  if (!mailCacheKey || mailCacheKey !== listKey(activeAccountId, activeFolder)) return;
  var old = listCache[mailCacheKey] || {};
  putListCache(mailCacheKey, { mails: mailCache.slice(), hasMore: hasMore, oldestSeq: oldestSeq, total: old.total, unseen: old.unseen });
}

function renderMailList(mails) {
  if (mails === mailCache) syncListCache();
  const el = document.getElementById('mail-list');
  if (mails.length === 0) {
    el.innerHTML = '<div class="detail-empty">' + richEmpty('noMailsTitle', 'noMailsDesc') + '</div>';
    return;
  }
  el.innerHTML = mails.map(function(m, i) {
    var from = m.from || {};
    var addr = from.address || '';
    var fullDate = formatDate(m.date);
    var date = formatShortDate(m.date);
    var checkbox = selectMode ? '<input type="checkbox" class="mail-checkbox" ' + (selectedUids.has(String(m.uid)) ? 'checked' : '') + ' onclick="toggleMailSelect(event, \'' + m.uid + '\')">' : '';
    var starCls = m.flagged ? 'mail-star active' : 'mail-star';
    var starIcon = m.flagged ? '<i class="bi bi-star-fill"></i>' : '<i class="bi bi-star"></i>';
    return '<div class="mail-row ' + (m.seen ? '' : 'unread') + (i === selectedMailIndex ? ' active' : '') + '" onclick="readMail(' + i + ')">' +
      checkbox +
      '<span class="' + starCls + '" onclick="toggleStarInList(event, ' + i + ')" title="' + esc(t(m.flagged ? 'unstar' : 'star')) + '">' + starIcon + '</span>' +
      '<div class="mail-col">' +
        '<div class="mail-row-top">' +
          '<span class="mail-from" title="' + esc(addr) + '">' + esc(from.name || addr) + '</span>' +
          '<span class="mail-date" title="' + esc(fullDate) + '">' + esc(date) + '</span>' +
        '</div>' +
        '<div class="mail-subject">' + esc(m.subject) + '</div>' +
      '</div>' +
    '</div>';
  }).join('') +
  (hasMore ? '<div id="load-more-btn" class="load-more-btn" onclick="loadMoreMails()">' + t('loadMore') + '</div>' : '');
}

async function readMail(index) {
  var mail = mailCache[index];
  if (!mail) return;
  selectedMailIndex = index;
  saveImapView({ uid: mail.uid });
  document.querySelectorAll('.mail-row').forEach(function(r, i) {
    r.classList.toggle('active', i === index);
  });
  var el = document.getElementById('mail-detail');
  el.innerHTML = '<div class="loading">' + t('loading') + '</div>';
  try {
    var data = await api('GET', '/api/accounts/' + activeAccountId + '/mails/' + mail.uid + '?folder=' + encodeURIComponent(activeFolder));
    var bodyHtml = '';
    if (data.html) {
      bodyHtml = '<iframe id="mail-iframe" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>';
    } else {
      bodyHtml = '<pre style="white-space:pre-wrap;font-family:inherit;">' + esc(data.text) + '</pre>';
    }
    var attachments = data.attachments || [];
    var attachHtml = '';
    if (attachments.length > 0) {
      attachHtml = '<div class="detail-attachments" aria-label="' + esc(t('attachments')) + '">' +
        attachments.map(function(a) {
          var dlUrl = API_PREFIX + '/api/accounts/' + activeAccountId + '/mails/' + encodeURIComponent(mail.uid) + '/attachments/' + encodeURIComponent(a.index) + '?folder=' + encodeURIComponent(activeFolder);
          return '<a href="' + esc(dlUrl) + '" download title="' + esc(a.filename) + '"><i class="bi bi-paperclip"></i><span class="att-name">' + esc(a.filename) + '</span><span class="att-size">' + (a.size / 1024).toFixed(1) + ' KB</span></a>';
        }).join('') + '</div>';
    }
    var isSeen = mail.seen;
    var isFlagged = mail.flagged;
    var moveOptions = folderCache.filter(function(f) { return f.path !== activeFolder; })
      .map(function(f) { return '<option value="' + esc(f.path) + '">' + esc(translateFolder(f.name)) + '</option>'; }).join('');
    var actionBtn = function(onclick, icon, key, extra) {
      return '<button type="button" class="action-btn' + (extra || '') + '" onclick="' + onclick + '" title="' + esc(t(key)) + '" aria-label="' + esc(t(key)) + '"><i class="bi ' + icon + '"></i></button>';
    };
    var sender = mail.from || {};
    var initial = (sender.name || sender.address || data.from || '?').trim().charAt(0);

    el.innerHTML =
      '<div class="detail-actions">' +
        '<button type="button" class="detail-back" onclick="showMailListView()" aria-label="' + esc(t('backToList')) + '"><i class="bi bi-chevron-left"></i><span class="back-label">' + esc(t('backToList')) + '</span></button>' +
        actionBtn('toggleReadDetail()', isSeen ? 'bi-envelope' : 'bi-envelope-open', isSeen ? 'markUnread' : 'markRead') +
        actionBtn('toggleStarDetail()', isFlagged ? 'bi-star-fill' : 'bi-star', isFlagged ? 'unstar' : 'star') +
        '<span class="action-sep"></span>' +
        actionBtn('moveMailDetail(\'Trash\')', 'bi-trash', 'moveToTrash') +
        actionBtn('deleteMailDetail()', 'bi-x-circle', 'deleteButton', ' danger') +
        '<select class="action-select" aria-label="' + esc(t('moveToFolder')) + '" onchange="moveMailDetail(this.value); this.selectedIndex=0;"><option value="">' + esc(t('moveToFolder')) + '</option>' + moveOptions + '</select>' +
      '</div>' +
      '<div class="detail-header">' +
        '<h2 class="detail-subject">' + esc(data.subject) + '</h2>' +
        '<div class="detail-meta">' +
          '<span class="detail-avatar">' + esc(initial) + '</span>' +
          '<div class="detail-meta-main">' +
            '<div class="detail-from">' + makeCopyable(data.from) + '</div>' +
            '<div class="detail-recipients"><span class="label">' + esc(t('to')) + ':</span>' + makeCopyable(data.to) + '</div>' +
            (data.cc ? '<div class="detail-recipients"><span class="label">' + esc(t('cc')) + ':</span>' + makeCopyable(data.cc) + '</div>' : '') +
          '</div>' +
          '<span class="detail-date">' + esc(formatDate(data.date)) + '</span>' +
        '</div>' +
      '</div>' +
      '<hr class="detail-divider">' +
      attachHtml +
      '<div class="detail-body"><div class="mail-body-container">' + bodyHtml + '</div></div>';
    if (data.html) {
      var iframe = document.getElementById('mail-iframe');
      var renderProtectedBody = function(allowImages) {
        iframe = EmailPrivacy.freshFrame(iframe);
        iframe.onload = null;
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        EmailPrivacy.control(iframe, data.html, allowImages, renderProtectedBody);
        var doc = iframe.contentDocument;
        doc.open();
        doc.write('<!DOCTYPE html><html><head>' + EmailPrivacy.head(allowImages) + '<style>img{max-width:100%;height:auto;}</style></head><body>' + EmailPrivacy.prepare(data.html, allowImages) + '</body></html>');
        doc.close();
        doc.querySelectorAll('a[href]').forEach(function(a) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        });
        var recalc = function() { iframe.style.height = doc.body.scrollHeight + 40 + 'px'; };
        doc.querySelectorAll('img').forEach(function(img) {
          if (!img.complete) {
            img.addEventListener('load', recalc);
            img.addEventListener('error', recalc);
          }
        });
        recalc();
        setTimeout(recalc, 200);
        setTimeout(recalc, 800);
      };
      iframe.onload = function() { renderProtectedBody(false); };
      iframe.src = 'about:blank';
    }
    mail.seen = true;
    detailVisible = true;
    syncResponsiveView();
    renderMailList(mailCache);
  } catch (err) {
    el.innerHTML = '<div class="detail-empty">' + err.message + '</div>';
    detailVisible = true;
    syncResponsiveView();
  }
}

function refreshMails() {
  selectedMailIndex = -1;  // 详情会被清空，列表高亮也一起去掉
  loadMails();
  resetMailDetail();
}

async function loadMoreMails() {
  if (!activeAccountId || !oldestSeq) return;
  var btn = document.getElementById('load-more-btn');
  if (btn) btn.textContent = t('loading');
  try {
    var data = await api('GET', '/api/accounts/' + activeAccountId + '/mails?folder=' + encodeURIComponent(activeFolder) + '&count=30&before=' + oldestSeq);
    var newMails = data.mails || [];
    mailCache = mailCache.concat(newMails);
    hasMore = data.hasMore;
    if (newMails.length > 0) {
      oldestSeq = Math.min.apply(null, newMails.map(function(m) { return m.seq; }));
    }
    renderMailList(mailCache);
  } catch (err) {
    if (btn) btn.textContent = t('retryLoadMore');
  }
}

// === 搜索 ===
async function doSearch() {
  var q = document.getElementById('search-input').value.trim();
  if (!q || !activeAccountId) return;
  detailVisible = false;
  syncResponsiveView();
  var el = document.getElementById('mail-list');
  el.innerHTML = '<div class="loading">' + t('searching') + '</div>';
  try {
    var field = document.getElementById('search-field').value || 'subject';
    var mails = await api('GET', '/api/accounts/' + activeAccountId + '/search?folder=' + encodeURIComponent(activeFolder) + '&q=' + encodeURIComponent(q) + '&field=' + field);
    loadSeq++;           // 作废还在路上的列表刷新，别让它把搜索结果顶掉
    mailCacheKey = null;  // 搜索结果不写回文件夹缓存
    mailCache = mails;
    hasMore = false;
    selectedMailIndex = -1;
    setMailInfo(t('searchSummary', { count: mails.length }));
    renderMailList(mails);
  } catch (err) {
    el.innerHTML = '<div class="detail-empty">' + err.message + '</div>';
  }
}

document.getElementById('search-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doSearch();
});

// === 弹窗 ===
function switchTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.getElementById('tab-single').classList.toggle('active', tab === 'single');
  document.getElementById('tab-batch').classList.toggle('active', tab === 'batch');
}

var PRESET_LABELS = { gmail: 'Gmail', gmx: 'GMX', outlook: 'Outlook', qq: 'QQ', '163': '163', yahoo: 'Yahoo', caramail: 'Caramail' };

async function showAddModal(tab) {
  document.getElementById('add-modal').classList.add('show');
  document.getElementById('modal-error').textContent = '';
  document.getElementById('batch-error').textContent = '';
  document.getElementById('batch-results').classList.remove('show');
  switchTab(tab || 'single');
  resetDiscover();
  try {
    var presets = await api('GET', '/api/presets');
    var sel = document.getElementById('m-preset');
    var current = sel.value || 'auto';
    sel.innerHTML = '<option value="auto" data-i18n="autoPreset">' + t('autoPreset') + '</option>' +
      presets.map(function(p) { return '<option value="' + esc(p) + '">' + esc(PRESET_LABELS[p] || p) + '</option>'; }).join('')
      + '<option value="custom">' + t('customPreset') + '</option>';
    sel.value = current;
  } catch(e) {}
}

function hideAddModal() {
  document.getElementById('add-modal').classList.remove('show');
}

function onPresetChange() {
  var preset = document.getElementById('m-preset').value;
  document.getElementById('custom-fields').style.display = preset === 'custom' ? 'block' : 'none';
  if (preset === 'auto') runDiscover();
  else setDetectStatus('');
}

// === 自动识别 IMAP 服务器 ===
var discoverTimer = null;
var discoverSeq = 0;
var discovered = null;

function resetDiscover() {
  clearTimeout(discoverTimer);
  discoverSeq++;
  discovered = null;
  document.getElementById('m-preset').value = 'auto';
  document.getElementById('custom-fields').style.display = 'none';
  setDetectStatus('');
}

function setDetectStatus(kind, text) {
  var el = document.getElementById('detect-status');
  el.className = 'detect-status' + (kind ? ' ' + kind : '');
  if (!kind) { el.innerHTML = ''; return; }
  var icon = { busy: 'bi-arrow-repeat', ok: 'bi-check-circle', fail: 'bi-exclamation-circle' }[kind];
  el.innerHTML = '<i class="bi ' + icon + '"></i><span>' + esc(text) + '</span>' +
    (kind === 'ok' ? '<button type="button" class="detect-edit" onclick="editDetectedServer()">' + esc(t('editServer')) + '</button>' : '');
}

function scheduleDiscover() {
  clearTimeout(discoverTimer);
  discoverTimer = setTimeout(runDiscover, 600);
}

async function runDiscover() {
  clearTimeout(discoverTimer);
  if (document.getElementById('m-preset').value !== 'auto') return;
  var email = document.getElementById('m-email').value.trim();
  var domain = email.split('@')[1] || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { discovered = null; setDetectStatus(''); return; }
  if (discovered && discovered.domain === domain.toLowerCase()) return;
  var seq = ++discoverSeq;
  discovered = null;
  setDetectStatus('busy', t('detecting'));
  try {
    var r = await api('GET', '/api/discover?email=' + encodeURIComponent(email));
    if (seq !== discoverSeq) return;
    discovered = { domain: domain.toLowerCase(), host: r.host, port: r.port };
    setDetectStatus('ok', t('detected', { host: r.host, port: r.port }));
  } catch (err) {
    if (seq !== discoverSeq) return;
    // 识别不出来就直接切到自定义，并按最常见的写法预填
    document.getElementById('m-preset').value = 'custom';
    document.getElementById('custom-fields').style.display = 'block';
    document.getElementById('m-host').value = 'imap.' + domain;
    document.getElementById('m-port').value = '993';
    setDetectStatus('fail', t('detectFailed'));
  }
}

function editDetectedServer() {
  if (!discovered) return;
  document.getElementById('m-preset').value = 'custom';
  document.getElementById('custom-fields').style.display = 'block';
  document.getElementById('m-host').value = discovered.host;
  document.getElementById('m-port').value = discovered.port;
  setDetectStatus('');
  document.getElementById('m-host').focus();
}

async function doAddAccount() {
  var preset = document.getElementById('m-preset').value;
  var email = document.getElementById('m-email').value.trim();
  var password = document.getElementById('m-pass').value;
  var host = document.getElementById('m-host').value.trim();
  var port = document.getElementById('m-port').value.trim();
  if (preset === 'auto') {
    var domain = (email.split('@')[1] || '').toLowerCase();
    host = discovered && discovered.domain === domain ? discovered.host : '';
    port = discovered && discovered.domain === domain ? String(discovered.port) : '';
  }
  var errEl = document.getElementById('modal-error');
  if (!email || !password) { errEl.textContent = t('fillCredentials'); return; }
  errEl.textContent = '';
  try {
    var acc = await api('POST', '/api/accounts', { preset: preset, email: email, password: password, host: host, port: port });
    hideAddModal();
    activeAccountId = acc.id;
    activeFolder = 'INBOX';
    saveImapView({ account: acc.id, folder: 'INBOX', uid: null });
    await loadAccounts();
    await loadFolders(acc.id);
    await loadMails();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// === 批量导入 ===
async function doBatchImport() {
  var text = document.getElementById('batch-input').value.trim();
  var errEl = document.getElementById('batch-error');
  var resEl = document.getElementById('batch-results');
  if (!text) { errEl.textContent = t('importRequired'); return; }

  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  if (lines.length === 0) { errEl.textContent = t('importRequired'); return; }

  errEl.textContent = '';
  resEl.innerHTML = '<div class="loading">' + t('importing', { count: lines.length }) + '</div>';
  resEl.classList.add('show');

  try {
    var results = await api('POST', '/api/accounts/batch', { lines: lines });
    var html = '';
    var successCount = 0;
    results.forEach(function(r) {
      if (r.ok) {
        successCount++;
        html += '<div class="batch-row success"><span>' + esc(r.email) + '</span><span>' + t('importSuccess') + '</span></div>';
      } else {
        html += '<div class="batch-row fail"><span>' + esc(r.email) + '</span><span>' + esc(r.error) + '</span></div>';
      }
    });
    resEl.innerHTML = '<div class="batch-summary">' + t('importDone', { success: successCount, total: results.length }) + '</div>' + html;

    await loadAccounts();
    if (successCount > 0 && !activeAccountId) {
      var first = results.find(function(r) { return r.ok; });
      if (first) selectAccount(first.id);
    }
  } catch (err) {
    errEl.textContent = err.message;
    resEl.classList.remove('show');
  }
}

// === 邮件操作 ===
async function toggleStarInList(event, index) {
  event.stopPropagation();
  var mail = mailCache[index];
  if (!mail || !activeAccountId) return;
  var action = mail.flagged ? 'remove' : 'add';
  try {
    await api('PUT', '/api/accounts/' + activeAccountId + '/mails/' + mail.uid + '/flags?folder=' + encodeURIComponent(activeFolder), { action: action, flags: ['\\Flagged'] });
    mail.flagged = !mail.flagged;
    renderMailList(mailCache);
  } catch (err) {
    alert(t('operationFailed') + ': ' + err.message);
  }
}

async function toggleReadDetail() {
  if (selectedMailIndex < 0) return;
  var mail = mailCache[selectedMailIndex];
  if (!mail || !activeAccountId) return;
  var action = mail.seen ? 'remove' : 'add';
  try {
    await api('PUT', '/api/accounts/' + activeAccountId + '/mails/' + mail.uid + '/flags?folder=' + encodeURIComponent(activeFolder), { action: action, flags: ['\\Seen'] });
    mail.seen = !mail.seen;
    renderMailList(mailCache);
    readMail(selectedMailIndex);
  } catch (err) {
    alert(t('operationFailed') + ': ' + err.message);
  }
}

async function toggleStarDetail() {
  if (selectedMailIndex < 0) return;
  var mail = mailCache[selectedMailIndex];
  if (!mail || !activeAccountId) return;
  var action = mail.flagged ? 'remove' : 'add';
  try {
    await api('PUT', '/api/accounts/' + activeAccountId + '/mails/' + mail.uid + '/flags?folder=' + encodeURIComponent(activeFolder), { action: action, flags: ['\\Flagged'] });
    mail.flagged = !mail.flagged;
    renderMailList(mailCache);
    readMail(selectedMailIndex);
  } catch (err) {
    alert(t('operationFailed') + ': ' + err.message);
  }
}

async function deleteMailDetail() {
  if (selectedMailIndex < 0) return;
  var mail = mailCache[selectedMailIndex];
  if (!mail || !activeAccountId) return;
  if (!confirm(t('deleteConfirm'))) return;
  try {
    await api('DELETE', '/api/accounts/' + activeAccountId + '/mails/' + mail.uid + '?folder=' + encodeURIComponent(activeFolder));
    mailCache.splice(selectedMailIndex, 1);
    selectedMailIndex = -1;
    renderMailList(mailCache);
    resetMailDetail();
  } catch (err) {
    alert(t('operationFailed') + ': ' + err.message);
  }
}

async function moveMailDetail(destination) {
  if (!destination || selectedMailIndex < 0) return;
  var mail = mailCache[selectedMailIndex];
  if (!mail || !activeAccountId) return;
  try {
    await api('POST', '/api/accounts/' + activeAccountId + '/mails/' + mail.uid + '/move?folder=' + encodeURIComponent(activeFolder), { destination: destination });
    mailCache.splice(selectedMailIndex, 1);
    selectedMailIndex = -1;
    renderMailList(mailCache);
    resetMailDetail();
  } catch (err) {
    alert(t('operationFailed') + ': ' + err.message);
  }
}

// === 多选模式 ===
function toggleSelectMode() {
  selectMode = !selectMode;
  selectedUids.clear();
  document.getElementById('batch-bar').style.display = selectMode ? 'flex' : 'none';
  var selectBtn = document.getElementById('select-mode-btn');
  selectBtn.dataset.i18nTitle = selectMode ? 'exitSelectMode' : 'selectMode';
  selectBtn.title = t(selectBtn.dataset.i18nTitle);
  selectBtn.setAttribute('aria-label', selectBtn.title);
  updateBatchCount();
  renderMailList(mailCache);
}

function toggleMailSelect(event, uid) {
  event.stopPropagation();
  uid = String(uid);
  if (selectedUids.has(uid)) { selectedUids.delete(uid); } else { selectedUids.add(uid); }
  updateBatchCount();
}

function updateBatchCount() {
  document.getElementById('batch-count').textContent = selectedUids.size;
}

function batchSelectAll() {
  mailCache.forEach(function(m) { selectedUids.add(String(m.uid)); });
  updateBatchCount();
  renderMailList(mailCache);
}

function batchDeselectAll() {
  selectedUids.clear();
  updateBatchCount();
  renderMailList(mailCache);
}

async function doBatchAction(action) {
  if (selectedUids.size === 0 || !activeAccountId) return;
  if (action === 'delete' && !confirm(t('batchConfirmDelete', { n: selectedUids.size }))) return;
  var uids = Array.from(selectedUids);
  try {
    await api('POST', '/api/accounts/' + activeAccountId + '/batch?folder=' + encodeURIComponent(activeFolder), { uids: uids, action: action });
    if (action === 'delete') {
      mailCache = mailCache.filter(function(m) { return !selectedUids.has(String(m.uid)); });
      selectedUids.clear();
      updateBatchCount();
      renderMailList(mailCache);
      resetMailDetail();
    } else if (action === 'read') {
      mailCache.forEach(function(m) { if (selectedUids.has(String(m.uid))) m.seen = true; });
      renderMailList(mailCache);
    } else if (action === 'unread') {
      mailCache.forEach(function(m) { if (selectedUids.has(String(m.uid))) m.seen = false; });
      renderMailList(mailCache);
    } else if (action === 'flag') {
      mailCache.forEach(function(m) { if (selectedUids.has(String(m.uid))) m.flagged = true; });
      renderMailList(mailCache);
    } else if (action === 'unflag') {
      mailCache.forEach(function(m) { if (selectedUids.has(String(m.uid))) m.flagged = false; });
      renderMailList(mailCache);
    }
  } catch (err) {
    alert(t('operationFailed') + ': ' + err.message);
  }
}

// === 复制到剪贴板 ===
function copyEmail(text, event) {
  if (event) event.stopPropagation();
  navigator.clipboard.writeText(text).then(function() {
    var toast = document.getElementById('copy-toast');
    toast.textContent = t('copiedPrefix') + text;
    toast.classList.add('show');
    clearTimeout(copyEmail._timer);
    copyEmail._timer = setTimeout(function() { toast.classList.remove('show'); }, 1500);
  });
}

// === 文件夹中文名映射 ===
var FOLDER_ZH = {
  'INBOX': '收件箱',
  'Sent': '已发送',
  'Sent Messages': '已发送',
  'Sent Mail': '已发送',
  'Drafts': '草稿箱',
  'Draft': '草稿箱',
  'Trash': '回收站',
  'Deleted': '已删除',
  'Deleted Messages': '已删除',
  'Deleted Items': '已删除',
  'Junk': '垃圾邮件',
  'Junk E-mail': '垃圾邮件',
  'Spam': '垃圾邮件',
  'Archive': '归档',
  'Archives': '归档',
  'All Mail': '所有邮件',
  'All': '所有邮件',
  'Flagged': '星标邮件',
  'Starred': '星标邮件',
  'Important': '重要',
  'Notes': '备忘录',
  'Outbox': '发件箱',
};

var FOLDER_KEYS = {};
Object.keys(FOLDER_ZH).forEach(function(k) { FOLDER_KEYS[k.toLowerCase()] = k; });

// 大小写不敏感（GMX 的 OUTBOX、INBOX），并匹配 [Gmail]/Sent Mail 等带前缀的路径
function folderKey(name) {
  var n = String(name || '');
  var base = n.replace(/^(\[.*?\]\/?)/, '');
  return FOLDER_KEYS[n.toLowerCase()] || FOLDER_KEYS[base.toLowerCase()] || null;
}

function translateFolder(name) {
  var key = folderKey(name);
  if (!key) return name;
  if (currentLang === 'zh') return FOLDER_ZH[key];
  // 其他语言的文件夹名按中文名查（i18n.js 的 folders 段），查不到用英文
  var folders = ManyMailI18n.section(currentLang, 'folders') || {};
  return folders[FOLDER_ZH[key]] || (key === 'INBOX' ? 'Inbox' : key);
}

var FOLDER_ICONS = {
  '收件箱': 'bi-inbox', '已发送': 'bi-send', '草稿箱': 'bi-file-earmark-text', '回收站': 'bi-trash',
  '已删除': 'bi-trash', '垃圾邮件': 'bi-exclamation-octagon', '归档': 'bi-archive', '所有邮件': 'bi-collection',
  '星标邮件': 'bi-star', '重要': 'bi-bookmark', '备忘录': 'bi-journal-text', '发件箱': 'bi-box-arrow-up',
};

function folderIcon(name) {
  var key = folderKey(name);
  return (key && FOLDER_ICONS[FOLDER_ZH[key]]) || 'bi-folder';
}

// === 工具函数 ===
// 同时用于文本和属性值，所以引号也要转义
function esc(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 将文本中的邮箱地址后面添加复制按钮
function makeCopyable(text) {
  if (!text) return '';
  return esc(text).replace(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g, function(addr) {
    return addr + ' <span class="copy-btn" onclick="copyEmail(\'' + addr + '\', event)" title="' + esc(t('copyEmailTitle')) + '"><i class="bi bi-clipboard"></i></span>';
  });
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleString(ManyMailI18n.locale(currentLang));
}

// 列表里的短日期：今天只显示时间，今年显示月日，更早带年份
function formatShortDate(d) {
  var ts = new Date(d);
  if (!d || Number.isNaN(ts.getTime())) return '';
  var now = new Date();
  var locale = ManyMailI18n.locale(currentLang);
  if (ts.toDateString() === now.toDateString()) {
    return ts.toLocaleTimeString(locale === 'en-US' ? 'en-GB' : locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  var opts = currentLang === 'zh' ? { month: 'numeric', day: 'numeric' } : { month: 'short', day: 'numeric' };
  if (ts.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return ts.toLocaleDateString(locale, opts);
}

// === 键盘快捷键 ===
var selectedMailIndex = -1;

document.addEventListener('keydown', function(e) {
  // 弹窗打开或输入框聚焦时不响应
  if (document.getElementById('add-modal').classList.contains('show')) {
    if (e.key === 'Escape') { hideAddModal(); e.preventDefault(); }
    return;
  }
  var tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') { document.activeElement.blur(); e.preventDefault(); }
    return;
  }

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      if (mailCache.length === 0) break;
      selectedMailIndex = Math.min(selectedMailIndex + 1, mailCache.length - 1);
      highlightMail(selectedMailIndex);
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      if (mailCache.length === 0) break;
      selectedMailIndex = Math.max(selectedMailIndex - 1, 0);
      highlightMail(selectedMailIndex);
      break;
    case 'Enter':
    case 'o':
      if (selectedMailIndex >= 0 && selectedMailIndex < mailCache.length) {
        readMail(selectedMailIndex);
      }
      break;
    case 'r':
      refreshMails();
      selectedMailIndex = -1;
      break;
    case '/':
      e.preventDefault();
      document.getElementById('search-input').focus();
      break;
    case 's':
      if (selectedMailIndex >= 0 && selectedMailIndex < mailCache.length) {
        toggleStarInList(e, selectedMailIndex);
      }
      break;
    case 'd':
    case '#':
      if (selectedMailIndex >= 0 && detailVisible) {
        deleteMailDetail();
      }
      break;
    case 'u':
      if (selectedMailIndex >= 0 && detailVisible) {
        toggleReadDetail();
      }
      break;
    case 'Escape':
      if (selectMode) { toggleSelectMode(); break; }
      selectedMailIndex = -1;
      document.querySelectorAll('.mail-row').forEach(function(r) { r.classList.remove('active'); });
      resetMailDetail();
      break;
  }
});

function highlightMail(index) {
  var rows = document.querySelectorAll('.mail-row');
  rows.forEach(function(r, i) { r.classList.toggle('active', i === index); });
  if (rows[index]) rows[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function restoreImapView(s) {
  if (s.account == null || activeAccountId != null) return;
  var account = accountCache.find(function(a) { return String(a.id) === String(s.account); });
  if (!account) return;
  activeAccountId = account.id;
  activeFolder = s.folder || 'INBOX';
  saveImapView({ account: activeAccountId, folder: activeFolder });
  loadAccounts();
  loadFolders(activeAccountId);
  await loadMails();
  if (s.uid == null || activeAccountId !== account.id) return;
  // 只在首屏（最近 30 封）里找，找不到就停在列表
  var index = mailCache.findIndex(function(m) { return String(m.uid) === String(s.uid); });
  if (index >= 0) readMail(index);
}

// 正在滚动的元素临时挂 .is-scrolling 让滚动条显示，停下 0.8 秒后收起（触控板/触屏没有 hover）
(function() {
  var timers = new WeakMap();
  document.addEventListener('scroll', function(e) {
    var el = e.target === document ? document.documentElement : e.target;
    if (!el.classList) return;
    el.classList.add('is-scrolling');
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(function() { el.classList.remove('is-scrolling'); }, 800));
  }, true);
})();

window.addEventListener('resize', syncResponsiveView);
syncResponsiveView();
// 后台把其他账号的收件箱和文件夹先拉一遍，第一次点过去也是秒开；一个一个来，不挤服务器
async function prefetchOtherAccounts() {
  for (var i = 0; i < accountCache.length; i++) {
    var id = accountCache[i].id;
    if (id === activeAccountId || document.hidden) continue;
    var key = acctKey(id);
    try {
      if (!listCache[listKey(id, 'INBOX')]) await fetchMailList(id, 'INBOX');
      if (!foldersByAccount[key]) {
        var folders = await api('GET', '/api/accounts/' + id + '/folders');
        foldersByAccount[key] = folders.filter(function(f) { return !f.noselect; });
        persistImapCache();
      }
    } catch (e) {}
  }
}

// === 新邮件：后端用 IMAP IDLE 实时盯着各账号收件箱，这里定时问一下版本号，变了才去拉列表 ===
// 不用 SSE：页面经 mail-viewer（gunicorn 同步 worker）代理，长连接会把 worker 占死
var CHANGES_INTERVAL = 15000;
var inboxVersions = null;  // 账号 id -> 上次看到的收件箱版本号
var changesTimer = null;

async function pollChanges() {
  clearTimeout(changesTimer);
  try {
    if (!document.hidden) {
      var data = await api('GET', '/api/changes');
      var next = {};
      Object.keys(data.accounts || {}).forEach(function(id) { next[id] = data.accounts[id].inbox; });
      if (inboxVersions) {
        Object.keys(next).forEach(function(id) {
          if (inboxVersions[id] !== undefined && inboxVersions[id] !== next[id]) onInboxChanged(Number(id));
        });
      }
      inboxVersions = next;
    }
  } catch (e) {}
  changesTimer = setTimeout(pollChanges, CHANGES_INTERVAL);
}

function onInboxChanged(id) {
  var key = listKey(id, 'INBOX');
  if (id === activeAccountId) loadFolderStatus(id);
  if (id === activeAccountId && activeFolder === 'INBOX' && mailCacheKey === key) {
    refreshListQuietly(id, 'INBOX');
  } else if (listCache[key]) {
    // 不在眼前的收件箱：后台把缓存更新好，点过去直接是新的
    fetchMailList(id, 'INBOX').catch(function() {});
  }
}

// 后台刷新当前列表：不动详情、不切移动端视图；「加载更多」翻出来的旧邮件按 UID 接回去（同一文件夹 UID 只增不减）
async function refreshListQuietly(accountId, folder) {
  var key = listKey(accountId, folder);
  var seq = loadSeq;  // 期间切了列表或搜索（都会让 loadSeq +1）就作废
  try {
    var fresh = await fetchMailList(accountId, folder);
    if (seq !== loadSeq || mailCacheKey !== key) return;
    var entry = fresh;
    if (fresh.mails.length) {
      var minUid = Math.min.apply(null, fresh.mails.map(function(m) { return m.uid; }));
      var older = mailCache.filter(function(m) { return m.uid < minUid; });
      if (older.length) entry = Object.assign({}, fresh, { mails: fresh.mails.concat(older), hasMore: hasMore, oldestSeq: oldestSeq });
    }
    applyMailList(key, entry, accountId, folder, true);
  } catch (e) {}
}

document.addEventListener('visibilitychange', function() {
  if (!document.hidden) pollChanges();
});

loadAccounts()
  .then(function() { return restoreImapView(pendingImapView); })
  .then(function() {
    pollChanges();
    setTimeout(prefetchOtherAccounts, 1500);
  })
  .catch(function() {});
applyLang();
