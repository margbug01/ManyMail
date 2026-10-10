// ---- i18n ----
const LANGS = {
    zh: {
        compose: '写邮件',
        queryInbox: '查询收件箱',
        selectDomain: '选择域名',
        loading: '加载中...',
        emailPrefix: '邮箱前缀',
        enterPrefix: '输入前缀',
        prefixExample: '例如：openai001',
        query: '查询',
        domainMgmt: '域名管理',
        enterDomain: '输入新域名，如 example.com',
        domainTip: '输入前缀即可查询邮件，邮箱不存在会自动创建。',
        mail: '邮件',
        inbox: '收件箱',
        sent: '已发送',
        trash: '回收站',
        attachments: '附件',
        download: '下载',
        restore: '恢复',
        permanentDelete: '彻底删除',
        noTrashMail: '回收站为空',
        attachmentUnavailable: '附件下载接口不可用',
        confirmRestore: '确定要恢复这封邮件吗？',
        confirmPermanentDelete: '确定要彻底删除这封邮件吗？此操作不可恢复。',
        auto: '自动',
        searchPlaceholder: '搜索邮件...',
        searchHint: '搜索发件人 / 主题 / 内容',
        clearSearchTitle: '清除搜索',
        selectAll: '全选',
        delete: '删除',
        markRead: '已读',
        queryHint: '请在左侧输入邮箱前缀查询',
        mailDetail: '邮件详情',
        selectMailHint: '请选择一封邮件查看详情',
        composeEmail: '撰写邮件',
        from: '发件人',
        prefix: '前缀',
        to: '收件人',
        toPlaceholder: '收件人邮箱，多个用逗号分隔',
        subject: '主题',
        subjectPlaceholder: '邮件主题',
        body: '正文',
        cancel: '取消',
        send: '发送',
        refresh: '刷新',
        reply: '回复',
        replyEmail: '回复邮件',
        noSubject: '(无主题)',
        unknownSender: '未知发件人',
        inboxEmpty: '收件箱为空',
        noSentMail: '暂无已发送邮件',
        noDomains: '暂无域名',
        noMatch: '没有找到匹配的邮件',
        loadMore: '加载更多',
        querying: '查询中...',
        searching: '搜索中...',
        sending: '发送中...',
        sentSuccess: '邮件发送成功！',
        sendFailed: '发送失败',
        loadFailed: '加载失败',
        queryFailed: '查询失败',
        searchFailed: '搜索失败',
        deleteFailed: '删除失败',
        networkError: '网络错误',
        enterDomainErr: '请输入域名',
        domainInvalid: '域名格式不正确',
        enterPrefixErr: '请输入邮箱前缀',
        fillFrom: '请填写发件人',
        fillTo: '请填写收件人',
        fillSubject: '请填写主题',
        fillBody: '请填写正文',
        selected: '已选 {n} 封',
        confirmDeleteN: '确定要删除选中的 {n} 封邮件吗？',
        confirmDelete1: '确定要删除这封邮件吗？',
        confirmDisableDomain: '确定要停用域名 "{d}" 吗？停用后该域名的邮件将不再接收。',
        emptyContent: '邮件内容为空',
        queryFirst: '请先查询一个邮箱',
        editorPlaceholder: '输入邮件正文...',
        time: '时间',
        autoRefreshTitle: '每 15 秒自动刷新',
        disableDomain: '停用此域名',
        verifyCode: '验证码',
        settings: '设置',
        openMailboxPanel: '邮箱面板',
        backToList: '返回列表',
        recentMailboxes: '最近邮箱',
        clearRecent: '清空最近邮箱',
        recentStale: '该域名已停用',
        copied: '已复制 {v}',
        copyFailed: '复制失败，请手动选中',
        copyCode: '点击复制验证码',
        undo: '撤销',
        mailDeleted: '邮件已删除',
        mailsDeleted: '已删除 {n} 封邮件',
        mailRestored: '邮件已恢复',
        undoFailed: '撤销失败，请到回收站恢复',
        markedRead: '已标记为已读',
        cc: '抄送',
        replyAll: '全部回复',
        forward: '转发',
        forwardEmail: '转发邮件',
        downloadEml: '下载原文',
        viewPlain: '纯文本',
        viewHtml: '原始显示',
        emlUnavailable: '上游未提供邮件原文接口',
        clearSearchBtn: '清除搜索条件',
        draftFound: '检测到未发送的草稿',
        restoreDraft: '恢复',
        discardDraft: '丢弃',
        discardTitle: '放弃草稿？',
        discardMsg: '关闭后当前编辑的内容会被丢弃。',
        discardOk: '丢弃并关闭',
        toHint: '回车或逗号确认，格式不合法会标红',
        addAttachment: '添加附件',
        attachmentSummary: '{n} 个附件 · {size}',
        attachmentTooLarge: '附件 {name} 超过 {max}MB 限制',
        attachmentTotalTooLarge: '附件总大小超过 {max}MB 限制',
        attachmentReadFailed: '附件读取失败：{name}',
        invalidRecipient: '收件人格式不正确，请修正标红的地址',
        confirmTitle: '请确认',
        permanentDeleteOk: '彻底删除',
        disableDomainOk: '停用',
        noRecent: '暂无记录',
    },
    en: {
        compose: 'Compose',
        queryInbox: 'Query Inbox',
        selectDomain: 'Select Domain',
        loading: 'Loading...',
        emailPrefix: 'Email Prefix',
        enterPrefix: 'Enter prefix',
        prefixExample: 'e.g. openai001',
        query: 'Query',
        domainMgmt: 'Domains',
        enterDomain: 'Enter domain, e.g. example.com',
        domainTip: 'Enter prefix to query. Mailbox auto-created if not exists.',
        inbox: 'Inbox',
        sent: 'Sent',
        trash: 'Trash',
        attachments: 'Attachments',
        download: 'Download',
        restore: 'Restore',
        permanentDelete: 'Delete forever',
        noTrashMail: 'Trash is empty',
        attachmentUnavailable: 'Attachment download API unavailable',
        confirmRestore: 'Restore this email?',
        confirmPermanentDelete: 'Permanently delete this email? This cannot be undone.',
        auto: 'Auto',
        searchPlaceholder: 'Search mail...',
        searchHint: 'Search sender / subject / content',
        clearSearchTitle: 'Clear search',
        selectAll: 'All',
        delete: 'Delete',
        markRead: 'Read',
        queryHint: 'Enter email prefix on the left to query',
        mailDetail: 'Mail Detail',
        selectMailHint: 'Select an email to view details',
        composeEmail: 'Compose Email',
        from: 'From',
        prefix: 'Prefix',
        to: 'To',
        toPlaceholder: 'Recipient email, separate with commas',
        subject: 'Subject',
        subjectPlaceholder: 'Email subject',
        body: 'Body',
        cancel: 'Cancel',
        send: 'Send',
        refresh: 'Refresh',
        reply: 'Reply',
        replyEmail: 'Reply',
        noSubject: '(No subject)',
        unknownSender: 'Unknown sender',
        inboxEmpty: 'Inbox is empty',
        noSentMail: 'No sent emails',
        noDomains: 'No domains',
        noMatch: 'No matching emails found',
        loadMore: 'Load more',
        querying: 'Querying...',
        searching: 'Searching...',
        sending: 'Sending...',
        sentSuccess: 'Email sent successfully!',
        sendFailed: 'Send failed',
        loadFailed: 'Load failed',
        queryFailed: 'Query failed',
        searchFailed: 'Search failed',
        deleteFailed: 'Delete failed',
        networkError: 'Network error',
        enterDomainErr: 'Please enter a domain',
        domainInvalid: 'Invalid domain format',
        enterPrefixErr: 'Please enter email prefix',
        fillFrom: 'Please fill in sender',
        fillTo: 'Please fill in recipient',
        fillSubject: 'Please fill in subject',
        fillBody: 'Please fill in body',
        selected: '{n} selected',
        confirmDeleteN: 'Delete {n} selected emails?',
        confirmDelete1: 'Delete this email?',
        confirmDisableDomain: 'Disable domain "{d}"? Emails to this domain will no longer be received.',
        emptyContent: 'Email content is empty',
        queryFirst: 'Please query a mailbox first',
        editorPlaceholder: 'Enter email body...',
        time: 'Time',
        autoRefreshTitle: 'Auto-refresh every 15s',
        disableDomain: 'Disable this domain',
        verifyCode: 'Code',
        settings: 'Settings',
        openMailboxPanel: 'Mailbox panel',
        backToList: 'Back',
        recentMailboxes: 'Recent',
        clearRecent: 'Clear recent mailboxes',
        recentStale: 'Domain disabled',
        copied: 'Copied {v}',
        copyFailed: 'Copy failed, select it manually',
        copyCode: 'Click to copy code',
        undo: 'Undo',
        mailDeleted: 'Email deleted',
        mailsDeleted: '{n} emails deleted',
        mailRestored: 'Email restored',
        undoFailed: 'Undo failed, restore it from Trash',
        markedRead: 'Marked as read',
        cc: 'Cc',
        replyAll: 'Reply all',
        forward: 'Forward',
        forwardEmail: 'Forward',
        downloadEml: 'Download .eml',
        viewPlain: 'Plain text',
        viewHtml: 'Rendered',
        emlUnavailable: 'Upstream provides no raw source endpoint',
        clearSearchBtn: 'Clear search',
        draftFound: 'Unsent draft found',
        restoreDraft: 'Restore',
        discardDraft: 'Discard',
        discardTitle: 'Discard draft?',
        discardMsg: 'Closing now will discard what you are editing.',
        discardOk: 'Discard and close',
        toHint: 'Press Enter or comma to confirm; invalid addresses turn red',
        addAttachment: 'Add attachment',
        attachmentSummary: '{n} files · {size}',
        attachmentTooLarge: 'Attachment {name} exceeds the {max}MB limit',
        attachmentTotalTooLarge: 'Attachments exceed the {max}MB total limit',
        attachmentReadFailed: 'Failed to read attachment: {name}',
        invalidRecipient: 'Fix the highlighted recipient addresses',
        confirmTitle: 'Please confirm',
        permanentDeleteOk: 'Delete forever',
        disableDomainOk: 'Disable',
        noRecent: 'No history',
    }
};

let currentLang = localStorage.getItem('manymail-lang') || 'zh';

function t(key, params) {
    let s = (LANGS[currentLang] || LANGS.zh)[key] || key;
    if (params) {
        Object.keys(params).forEach(k => { s = s.replace(`{${k}}`, params[k]); });
    }
    return s;
}

function applyLang() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPh);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
    });
    document.getElementById('lang-label').textContent = currentLang === 'zh' ? 'EN' : '中';
    document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
}

function toggleLang() {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('manymail-lang', currentLang);
    applyLang();
    const imapFrame = document.getElementById('imap-frame');
    try {
        imapFrame?.contentWindow?.postMessage({
            type: 'manymail-lang-change',
            lang: currentLang,
        }, window.location.origin);
    } catch (e) {}
    // re-render dynamic content
    if (currentMessages.length > 0 && currentTab === 'inbox') renderMessages(currentMessages);
    if (currentSentMessages.length > 0 && currentTab === 'sent') renderSentMessages(currentSentMessages);
    if (currentTrashMessages.length > 0 && currentTab === 'trash') renderTrashMessages(currentTrashMessages);
    if (!currentEmail) resetMailDetail();
    // applyLang 会把列表标题重置成"收件箱"，这里按当前 Tab 校回来
    _syncListHeader(currentTab);
    renderRecentMailboxes();
}

let currentEmail = '';
let currentMessages = [];
let currentSentMessages = [];
let currentTrashMessages = [];
let activeDomains = [];
let currentOffset = 0;
let currentTotal = 0;
let currentSentTotal = 0;
let currentTrashTotal = 0;
let imapLoaded = false;
let isSearchMode = false;
let _mailBodyResizeObserver = null;
const PAGE_SIZE = 30;
const RECENT_KEY = 'manymail-recent';
const DRAFT_KEY = 'manymail-draft';
const RECENT_MAX = 8;
const MAX_ATTACHMENT_MB = 5;
const MAX_ATTACHMENT_TOTAL_MB = 10;

// ---- Toast 通知 ----
function showToast(message, options = {}) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'app-toast' + (options.type ? ` toast-${options.type}` : '');

    const text = document.createElement('span');
    text.className = 'app-toast-text';
    text.textContent = message;
    toast.appendChild(text);

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        clearTimeout(timer);
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 220);
    };

    if (options.actionLabel && typeof options.onAction === 'function') {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'app-toast-action';
        action.textContent = options.actionLabel;
        action.onclick = () => { dismiss(); options.onAction(); };
        toast.appendChild(action);
    }

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    const timer = setTimeout(dismiss, options.duration || (options.actionLabel ? 6000 : 3200));
    return dismiss;
}

function toastError(message) {
    showToast(message, { type: 'error' });
}

// ---- 自定义确认弹窗，只用于不可逆操作 ----
let confirmModal = null;

function showConfirm({ title, message, okLabel, onConfirm }) {
    if (!confirmModal) {
        confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
    }
    document.getElementById('confirm-title').textContent = title || t('confirmTitle');
    document.getElementById('confirm-message').textContent = message || '';
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = okLabel || t('delete');
    okBtn.onclick = () => {
        confirmModal.hide();
        onConfirm();
    };
    document.getElementById('confirm-cancel').textContent = t('cancel');
    confirmModal.show();
}

// ---- 复制到剪贴板 ----
async function copyText(text, event) {
    if (event) event.stopPropagation();
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
    } catch (e) {
        toastError(t('copyFailed'));
    }
}

// ---- 窄屏主从视图切换（桌面端这两个函数不产生视觉变化） ----
function showMailDetailView() {
    const layout = document.getElementById('mail-layout');
    layout.classList.remove('mobile-view-list');
    layout.classList.add('mobile-view-detail');
}

function showMailListView() {
    const layout = document.getElementById('mail-layout');
    layout.classList.remove('mobile-view-detail');
    layout.classList.add('mobile-view-list');
}

// ---- 最近查询过的邮箱 ----
function loadRecentMailboxes() {
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : [];
    } catch (e) {
        return [];
    }
}

function saveRecentMailboxes(list) {
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) {}
}

function rememberMailbox(email) {
    if (!email) return;
    const list = loadRecentMailboxes().filter(x => x.toLowerCase() !== email.toLowerCase());
    list.unshift(email);
    saveRecentMailboxes(list);
    renderRecentMailboxes();
}

function removeRecentMailbox(email) {
    saveRecentMailboxes(loadRecentMailboxes().filter(x => x !== email));
    renderRecentMailboxes();
}

function clearRecentMailboxes() {
    saveRecentMailboxes([]);
    renderRecentMailboxes();
}

function renderRecentMailboxes() {
    const card = document.getElementById('recent-card');
    const list = document.getElementById('recent-list');
    const items = loadRecentMailboxes();
    if (items.length === 0) {
        card.style.display = 'none';
        list.innerHTML = '';
        return;
    }
    card.style.display = '';
    list.innerHTML = items.map(email => {
        const domain = email.split('@')[1] || '';
        // 域名列表还没加载完时不要误判为停用
        const stale = activeDomains.length > 0 && !activeDomains.includes(domain);
        const safe = _escapeHtml(email);
        const encoded = encodeURIComponent(email);
        return `
                    <span class="recent-pill${stale ? ' recent-stale' : ''}" title="${stale ? t('recentStale') : safe}">
                        <span class="recent-pill-label" ${stale ? '' : `onclick="useRecentMailbox(decodeURIComponent('${encoded}'))"`}>${safe}</span>
                        <button type="button" class="recent-pill-remove" onclick="removeRecentMailbox(decodeURIComponent('${encoded}'))" aria-label="remove">
                            <i class="bi bi-x-lg"></i>
                        </button>
                    </span>`;
    }).join('');
}

function useRecentMailbox(email) {
    const [prefix, domain] = email.split('@');
    const domainSelect = document.getElementById('inbox-domain');
    if (activeDomains.includes(domain)) {
        domainSelect.value = domain;
        document.getElementById('inbox-domain-display').textContent = '@' + domain;
    }
    document.getElementById('inbox-prefix').value = prefix || '';
    if (currentTab !== 'inbox') {
        switchTab('inbox');
    }
    closeLeftDrawer();
    queryInbox();
}

function closeLeftDrawer() {
    const el = document.getElementById('mail-left-column');
    const instance = bootstrap.Offcanvas.getInstance(el);
    if (instance) instance.hide();
}

// HTML 转义工具函数（防 XSS）
function _escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// 定宽邮件比详情栏宽时的缩放比例。留 12px 余量给 body 右侧内边距，
// 并设下限，避免超宽邮件被缩到看不清。
function _computeBodyScale(available, natural) {
    if (!available || !natural || natural <= available + 1) return 1;
    return Math.max(available / (natural + 12), 0.4);
}

function _renderMailBodyIframe(iframe, mailContent, allowImages = false) {
    iframe = EmailPrivacy.freshFrame(iframe);
    EmailPrivacy.control(iframe, mailContent, allowImages, allowed => _renderMailBodyIframe(iframe, mailContent, allowed));
    const protectedContent = EmailPrivacy.prepare(mailContent, allowImages);
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    iframe.setAttribute('scrolling', 'no');
    iframe.style.overflow = 'hidden';

    iframeDoc.open();
    // color-scheme 锁 light：详情区是浅色底，放任邮件的 prefers-color-scheme: dark
    // 规则生效会变成白字浅底，读不了
    iframeDoc.write(`<!DOCTYPE html><html><head>${EmailPrivacy.head(allowImages)}<meta charset="UTF-8"><meta name="color-scheme" content="light"><base target="_blank"><style>:root{color-scheme:light;}html,body{margin:0;padding:0;background:transparent;box-sizing:border-box;}body{font-family:"Noto Sans SC",system-ui,sans-serif;font-size:14px;color:#1a2421;padding:12px;word-break:break-word;overflow-wrap:anywhere;}img{max-width:100%;height:auto;}table{max-width:100%!important;}a{color:#4a7c9b;}</style></head><body>${protectedContent}</body></html>`);
    iframeDoc.close();

    // 强制所有链接在新标签页打开（覆盖邮件中显式设置的 target）
    iframeDoc.querySelectorAll('a[href]').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
    });

    // 从父页面计算尺寸（sandbox 无 allow-scripts，脚本无法在 iframe 内执行）
    const fitBody = () => {
        try {
            const body = iframeDoc.body;
            const doc = iframeDoc.documentElement;
            if (!body) return;

            // 先复位，量出内容不受约束时的自然宽度
            body.style.transform = 'none';
            body.style.width = 'auto';
            const available = iframe.clientWidth || iframe.offsetWidth || 0;
            const natural = Math.max(body.scrollWidth, doc ? doc.scrollWidth : 0);

            // 定宽邮件（常见 600px 表格）比详情栏宽时整体缩放，
            // 否则右边会被 overflow:hidden 直接裁掉
            const scale = _computeBodyScale(available, natural);
            if (scale < 1) {
                body.style.width = natural + 'px';
                body.style.transform = `scale(${scale})`;
            }

            const height = Math.max(
                body.scrollHeight,
                body.offsetHeight,
                doc ? doc.scrollHeight : 0,
                doc ? doc.offsetHeight : 0
            );
            iframe.style.height = Math.ceil(height * scale + 20) + 'px';
        } catch (e) {}
    };

    // 监听 iframe 内图片加载完成后重新适配
    iframeDoc.querySelectorAll('img').forEach(img => {
        if (!img.complete) {
            img.addEventListener('load', fitBody);
            img.addEventListener('error', fitBody);
        }
    });

    fitBody();
    setTimeout(fitBody, 200);
    setTimeout(fitBody, 800);

    // 详情栏宽度变了要重新适配（窗口缩放、桌面与窄屏互切）。
    // 只认宽度变化，否则 fitBody 改高度会把自己再触发一次。
    if (_mailBodyResizeObserver) _mailBodyResizeObserver.disconnect();
    if (window.ResizeObserver && iframe.parentElement) {
        let lastWidth = iframe.clientWidth;
        _mailBodyResizeObserver = new ResizeObserver(() => {
            const width = iframe.clientWidth;
            if (Math.abs(width - lastWidth) < 1) return;
            lastWidth = width;
            fitBody();
        });
        _mailBodyResizeObserver.observe(iframe.parentElement);
    }
}

// 更新未读邮件计数 badge
function _updateUnreadBadge() {
    const badge = document.getElementById('unread-badge');
    const unreadCount = currentMessages.filter(m => !m.seen).length;
    if (unreadCount > 0) {
        badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        badge.style.display = 'inline';
    } else {
        badge.style.display = 'none';
    }
}

function _attachmentId(att, index) {
    return encodeURIComponent(String(att.id || (att.index ?? index)));
}

function _formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (!n) return '';
    return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
}

function _renderAttachments(messageId, attachments) {
    if (!attachments || attachments.length === 0) return '';
    return `
                <div class="mb-3">
                    <strong><i class="bi bi-paperclip me-1"></i>${t('attachments')}:</strong>
                    <div class="mt-2 d-flex flex-wrap gap-2">
                        ${attachments.map((att, index) => {
                    const filename = att.filename || `attachment_${index}`;
                    const size = _formatSize(att.size);
                    const url = `/api/inbox/attachment/${encodeURIComponent(messageId)}/${_attachmentId(att, index)}?email=${encodeURIComponent(currentEmail)}&filename=${encodeURIComponent(filename)}`;
                    return `<a class="btn btn-sm btn-outline-secondary" href="${url}" download title="${t('download')}"><i class="bi bi-download me-1"></i>${_escapeHtml(filename)}${size ? ` <span class="text-muted">(${size})</span>` : ''}</a>`;
                }).join('')}
                    </div>
                </div>`;
}

// 域名选择联动
document.getElementById('inbox-domain').addEventListener('change', function() {
    document.getElementById('inbox-domain-display').textContent = '@' + this.value;
});

// ---- 域名管理（入口在 navbar 的设置弹窗里） ----
let settingsModal = null;

function openSettings() {
    if (!settingsModal) {
        settingsModal = new bootstrap.Modal(document.getElementById('settingsModal'));
    }
    document.getElementById('domain-error').style.display = 'none';
    settingsModal.show();
    loadDomains();
}

async function loadDomains() {
    const domainList = document.getElementById('domain-list');
    const domainSelect = document.getElementById('inbox-domain');
    try {
        const resp = await fetch('/api/domains');
        const data = await resp.json();
        if (!data.success) {
            domainList.innerHTML = `<div class="text-danger small">${_escapeHtml(data.message || t('loadFailed'))}</div>`;
            return;
        }
        const domains = (data.domains || []).filter(d => d.is_active);
        activeDomains = domains.map(d => d.domain);

        // 更新域名下拉框
        const prevSelected = domainSelect.value;
        domainSelect.innerHTML = activeDomains.map(d =>
            `<option value="${_escapeHtml(d)}">${_escapeHtml(d)}</option>`
        ).join('');
        if (activeDomains.includes(prevSelected)) {
            domainSelect.value = prevSelected;
        }
        if (domainSelect.value) {
            document.getElementById('inbox-domain-display').textContent = '@' + domainSelect.value;
        }

        // 更新域名管理列表
        if (activeDomains.length === 0) {
            domainList.innerHTML = `<div class="text-muted small text-center py-2">${t('noDomains')}</div>`;
        } else {
            domainList.innerHTML = activeDomains.map(d => `
                        <div class="d-flex justify-content-between align-items-center py-1 px-2 mb-1" style="background:#f5f9f7;border-radius:6px;">
                            <span class="small"><i class="bi bi-globe2 me-1 text-muted"></i>${_escapeHtml(d)}</span>
                            <button class="btn btn-sm p-0 text-danger" onclick="deleteDomain(decodeURIComponent('${encodeURIComponent(d)}'))" title="${t('disableDomain')}">
                                <i class="bi bi-x-lg" style="font-size:0.75rem;"></i>
                            </button>
                        </div>
                    `).join('');
        }
    } catch (e) {
        domainList.innerHTML = `<div class="text-danger small">${t('loadFailed')}: ${_escapeHtml(e.message)}</div>`;
    } finally {
        // 域名可用性变了，最近邮箱的置灰状态跟着刷新
        renderRecentMailboxes();
    }
}

async function addDomain() {
    const input = document.getElementById('new-domain-input');
    const errorDiv = document.getElementById('domain-error');
    const domain = input.value.trim().toLowerCase();
    errorDiv.style.display = 'none';

    if (!domain) {
        errorDiv.textContent = t('enterDomainErr');
        errorDiv.style.display = 'block';
        return;
    }
    if (!domain.includes('.') || domain.length < 3) {
        errorDiv.textContent = t('domainInvalid');
        errorDiv.style.display = 'block';
        return;
    }

    const btn = document.getElementById('btn-add-domain');
    btn.disabled = true;
    try {
        const resp = await fetch('/api/domains', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain })
        });
        const data = await resp.json();
        if (data.success) {
            input.value = '';
            await loadDomains();
        } else {
            errorDiv.textContent = data.message || t('loadFailed');
            errorDiv.style.display = 'block';
        }
    } catch (e) {
        errorDiv.textContent = t('networkError') + ': ' + e.message;
        errorDiv.style.display = 'block';
    } finally {
        btn.disabled = false;
    }
}

function deleteDomain(domain) {
    // 停用域名不可逆，保留确认
    showConfirm({
        title: t('disableDomain'),
        message: t('confirmDisableDomain', { d: domain }),
        okLabel: t('disableDomainOk'),
        onConfirm: () => _doDeleteDomain(domain),
    });
}

async function _doDeleteDomain(domain) {
    const errorDiv = document.getElementById('domain-error');
    errorDiv.style.display = 'none';
    try {
        const resp = await fetch(`/api/domains/${domain}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.success) {
            await loadDomains();
        } else {
            errorDiv.textContent = data.message || t('deleteFailed');
            errorDiv.style.display = 'block';
        }
    } catch (e) {
        errorDiv.textContent = t('networkError') + ': ' + e.message;
        errorDiv.style.display = 'block';
    }
}

// 页面加载时初始化语言 + 获取域名列表 + 最近邮箱
document.addEventListener('DOMContentLoaded', () => {
    applyLang();
    renderRecentMailboxes();
    loadDomains();
    _initRecipientInput();
    document.getElementById('compose-subject').addEventListener('input', saveDraft);
    document.getElementById('compose-from-prefix').addEventListener('input', saveDraft);
});
window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'mail-viewer-switch-tab' && event.data.tab) {
        switchTab(event.data.tab);
    }
});

function fitMobileImapFrame() {
    const frame = document.getElementById('imap-frame');
    if (!frame || !frame.getClientRects().length) return;
    if (window.matchMedia('(max-width: 991.98px)').matches) {
        const viewport = window.visualViewport;
        const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
        const height = Math.max(180, bottom - frame.getBoundingClientRect().top - 8);
        frame.style.height = height + 'px';
        frame.style.minHeight = '0';
    } else {
        frame.style.removeProperty('height');
        frame.style.removeProperty('min-height');
    }
}
window.addEventListener('resize', fitMobileImapFrame);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitMobileImapFrame);

function ensureImapLoaded() {
    requestAnimationFrame(fitMobileImapFrame);
    const frame = document.getElementById('imap-frame');
    if (!imapLoaded) {
        frame.src = '/imap/?embedded=1';
        imapLoaded = true;
    }
}

function reloadImapFrame() {
    const frame = document.getElementById('imap-frame');
    if (!imapLoaded) {
        ensureImapLoaded();
        return;
    }
    frame.src = '/imap/?embedded=1';
}

// ---- 自动刷新 ----
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL = 15000; // 15秒

function toggleAutoRefresh(enabled) {
    // 自动刷新只服务收件箱，别在已发送/回收站下把列表顶掉
    if (enabled && currentTab !== 'inbox') {
        document.getElementById('auto-refresh-toggle').checked = false;
        return;
    }
    if (enabled && currentEmail) {
        autoRefreshTimer = setInterval(() => { queryInbox(true); }, AUTO_REFRESH_INTERVAL);
    } else {
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
        document.getElementById('auto-refresh-toggle').checked = false;
    }
}

// ---- 收件箱 / 已发送 切换 ----
let currentTab = 'inbox';

// 记住上次停在哪个文件夹，从 IMAP 切回「邮件」时回到原处
let lastFolderTab = 'inbox';
const FOLDER_TABS = ['inbox', 'sent', 'trash'];

// 顶部模式切换 + 列表头文件夹分段控件的选中态都在这里同步
function _syncListHeader(tab) {
    const isImap = tab === 'imap';
    const setActive = (el, on) => {
        if (!el) return;
        el.classList.toggle('btn-primary', on);
        el.classList.toggle('btn-outline-secondary', !on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    setActive(document.getElementById('tab-mail'), !isImap);
    setActive(document.getElementById('tab-imap'), isImap);
    FOLDER_TABS.forEach(f => setActive(document.getElementById(`tab-${f}`), f === tab));
    document.getElementById('mail-list-mailbox').textContent = currentEmail || '';
}

function switchTab(tab) {
    currentTab = tab;
    if (FOLDER_TABS.includes(tab)) lastFolderTab = tab;
    const searchBar = document.getElementById('search-bar');
    const batchBar = document.getElementById('batch-bar');
    const leftColumn = document.getElementById('mail-left-column');
    const listColumn = document.getElementById('mail-list-column');
    const detailColumn = document.getElementById('mail-detail-column');
    const imapPanel = document.getElementById('imap-panel');

    // 切走任何一个非收件箱 Tab 都要停掉定时器，否则收件箱刷新会顶掉当前列表
    if (tab !== 'inbox' && autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
        document.getElementById('auto-refresh-toggle').checked = false;
    }
    isSearchMode = false;
    showMailListView();
    _syncListHeader(tab);
    // IMAP 面板下左栏整个隐藏了，抽屉按钮也一并收起
    document.getElementById('btn-left-drawer').classList.toggle('d-none', tab === 'imap');

    if (tab === 'inbox') {
        leftColumn.style.display = '';
        listColumn.style.display = '';
        detailColumn.style.display = '';
        imapPanel.style.display = 'none';
        batchBar.style.display = currentMessages.length > 0 ? 'flex' : 'none';
        searchBar.style.display = currentEmail ? 'flex' : 'none';
        if (currentMessages.length > 0) {
            renderMessages(currentMessages);
        } else if (currentEmail) {
            queryInbox();
        }
        resetMailDetail();
    } else {
        searchBar.style.display = 'none';
        document.getElementById('search-input').value = '';
        batchBar.style.display = 'none';
        if (tab === 'sent' || tab === 'trash') {
            leftColumn.style.display = '';
            listColumn.style.display = '';
            detailColumn.style.display = '';
            imapPanel.style.display = 'none';
            if (currentEmail) {
                tab === 'sent' ? querySent() : queryTrash();
            } else {
                document.getElementById('mail-list').innerHTML = `<div class="text-center text-muted py-4"><i class="bi bi-arrow-left me-2"></i>${t('queryFirst')}</div>`;
            }
            resetMailDetail();
        } else {
            leftColumn.style.display = 'none';
            listColumn.style.display = 'none';
            detailColumn.style.display = 'none';
            imapPanel.style.display = 'block';
            ensureImapLoaded();
        }
    }
}

function refreshCurrentTab() {
    if (currentTab === 'inbox') queryInbox();
    else if (currentTab === 'sent') querySent();
    else if (currentTab === 'trash') queryTrash();
    else reloadImapFrame();
}

async function querySent(append = false) {
    if (!currentEmail) return;
    const mailList = document.getElementById('mail-list');
    const offset = append ? currentSentMessages.length : 0;
    if (!append) mailList.innerHTML = `<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> ${t('loading')}</div>`;

    try {
        const resp = await fetch('/api/sent/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, offset, limit: PAGE_SIZE })
        });
        const data = await resp.json();
        if (!data.success) {
            mailList.innerHTML = `<div class="error-state"><p>${_escapeHtml(data.message || t('loadFailed'))}</p></div>`;
            return;
        }
        currentSentTotal = data.total || data.messages.length;
        renderSentMessages(append ? currentSentMessages.concat(data.messages) : data.messages);
    } catch (e) {
        mailList.innerHTML = `<div class="error-state"><p>${t('loadFailed')}: ${_escapeHtml(e.message)}</p></div>`;
    }
}

function renderSentMessages(messages) {
    currentSentMessages = messages;
    const mailList = document.getElementById('mail-list');
    if (messages.length === 0) {
        mailList.innerHTML = `<div class="empty-state"><i class="bi bi-send d-block"></i><p>${t('noSentMail')}</p></div>`;
        return;
    }
    mailList.innerHTML = messages.map(msg => {
        const toStr = _escapeHtml((msg.to || []).join(', '));
        const subject = _escapeHtml(msg.subject || t('noSubject'));
        return `
                    <div class="card mb-2 mail-item" data-msg-id="${msg.id}" onclick="viewSentDetailById('${msg.id}', this)">
                        <div class="card-body py-2">
                            <div class="d-flex justify-content-between align-items-start">
                                <strong><i class="bi bi-arrow-right me-1 text-muted"></i><span class="mail-copy">${toStr}</span></strong>
                                <small class="text-muted mail-time" title="${_fullDate(msg.createdAt)}">${_shortDate(msg.createdAt)}</small>
                            </div>
                            <div class="text-truncate"><span class="mail-copy">${subject}</span></div>
                        </div>
                    </div>`;
    }).join('');
    if (currentSentTotal > currentSentMessages.length) {
        mailList.insertAdjacentHTML('beforeend', `<div class="text-center py-3"><button class="btn btn-outline-primary btn-sm" onclick="querySent(true)"><i class="bi bi-arrow-down-circle me-1"></i>${t('loadMore')} (${currentSentMessages.length}/${currentSentTotal})</button></div>`);
    }
}

async function viewSentDetailById(messageId, element) {
    const msg = currentSentMessages.find(item => item.id === messageId);
    if (!msg) return;
    document.querySelectorAll('.mail-item').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');
    showMailDetailView();
    document.getElementById('mail-detail-content').innerHTML = `<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> ${t('loading')}</div>`;
    try {
        const resp = await fetch('/api/sent/detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, message_id: messageId })
        });
        const data = await resp.json();
        viewSentDetail(element, data.success ? data.detail : msg);
    } catch (e) {
        viewSentDetail(element, msg);
    }
}

function viewSentDetail(element, msg) {
    document.querySelectorAll('.mail-item').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');
    const detailContent = document.getElementById('mail-detail-content');
    const toStr = _escapeHtml((msg.to || []).join(', '));
    detailContent.innerHTML = `
                <div class="mb-3"><strong>${t('from')}:</strong> ${_escapeHtml(msg.from_address || currentEmail)}</div>
                <div class="mb-3"><strong>${t('to')}:</strong> ${toStr}</div>
                <div class="mb-3"><strong>${t('subject')}:</strong> ${_escapeHtml(msg.subject || t('noSubject'))}</div>
                <div class="mb-3"><strong>${t('time')}:</strong> ${new Date(msg.createdAt).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US')}</div>
                <hr>
                <div class="mail-body-container" style="background:#f8f9fa; padding:0; border-radius:8px; overflow:hidden;">
                    <iframe id="sent-body-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" style="width:100%;border:none;min-height:200px;"></iframe>
                </div>`;
    // 安全渲染已发送邮件内容
    const iframe = document.getElementById('sent-body-frame');
    const mailContent = msg.html || _escapeHtml(msg.text || '').replace(/\n/g, '<br>') || `<i style="color:#6c757d;">${t('emptyContent')}</i>`;
    _renderMailBodyIframe(iframe, mailContent);
}

async function queryTrash(append = false) {
    if (!currentEmail) return;
    const mailList = document.getElementById('mail-list');
    const offset = append ? currentTrashMessages.length : 0;
    if (!append) mailList.innerHTML = `<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> ${t('loading')}</div>`;

    try {
        const resp = await fetch('/api/trash/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, offset, limit: PAGE_SIZE })
        });
        const data = await resp.json();
        if (!data.success) {
            mailList.innerHTML = `<div class="error-state"><p>${_escapeHtml(data.message || t('loadFailed'))}</p></div>`;
            return;
        }
        currentTrashTotal = data.total || data.messages.length;
        renderTrashMessages(append ? currentTrashMessages.concat(data.messages) : data.messages);
    } catch (e) {
        mailList.innerHTML = `<div class="error-state"><p>${t('loadFailed')}: ${_escapeHtml(e.message)}</p></div>`;
    }
}

function renderTrashMessages(messages) {
    currentTrashMessages = messages;
    const mailList = document.getElementById('mail-list');
    if (messages.length === 0) {
        mailList.innerHTML = `<div class="empty-state"><i class="bi bi-trash d-block"></i><p>${t('noTrashMail')}</p></div>`;
        return;
    }
    mailList.innerHTML = messages.map(msg => `
                <div class="card mb-2 mail-item" data-msg-id="${msg.id}" onclick="viewMailDetail('${msg.id}', this, true)">
                    <div class="card-body py-2">
                        <div class="d-flex justify-content-between align-items-start">
                            <span class="mail-sender text-truncate me-2"><span class="mail-copy">${_escapeHtml(msg.from?.name || msg.from?.address || t('unknownSender'))}</span></span>
                            <small class="text-muted mail-time" title="${_fullDate(msg.createdAt)}">${_shortDate(msg.createdAt)}</small>
                        </div>
                        <div class="mail-subject text-truncate"><span class="mail-copy">${_escapeHtml(msg.subject || t('noSubject'))}</span></div>
                        <small class="mail-intro text-muted text-truncate d-block"><span class="mail-copy">${_escapeHtml(msg.intro || '')}</span></small>
                    </div>
                </div>
            `).join('');
    if (currentTrashTotal > currentTrashMessages.length) {
        mailList.insertAdjacentHTML('beforeend', `<div class="text-center py-3"><button class="btn btn-outline-primary btn-sm" onclick="queryTrash(true)"><i class="bi bi-arrow-down-circle me-1"></i>${t('loadMore')} (${currentTrashMessages.length}/${currentTrashTotal})</button></div>`);
    }
}

function resetMailDetail() {
    document.getElementById('mail-detail-content').innerHTML = `
                <div class="text-center text-muted py-5">
                    <i class="bi bi-envelope-paper" style="font-size:3rem;opacity:0.3;"></i>
                    <p class="mt-3">${t('selectMailHint')}</p>
                </div>`;
    document.querySelectorAll('.mail-item').forEach(el => el.classList.remove('active'));
    window._currentDetailMsg = null;
    showMailListView();
}

async function queryInbox(silent = false, append = false) {
    if (!silent && !append) resetMailDetail();
    const prefix = document.getElementById('inbox-prefix').value.trim();
    const domain = document.getElementById('inbox-domain').value;
    const email = prefix ? `${prefix}@${domain}` : '';
    const errorDiv = document.getElementById('inbox-error');
    const btn = document.getElementById('btn-query-inbox');
    const mailList = document.getElementById('mail-list');

    if (!prefix) {
        if (!silent) {
            errorDiv.textContent = t('enterPrefixErr');
            errorDiv.style.display = 'block';
        }
        return;
    }

    // 计算分页偏移量
    const reqOffset = append ? currentMessages.length : 0;

    errorDiv.style.display = 'none';
    if (!silent && !append) {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('querying')}`;
        mailList.innerHTML = `
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
                    </div>`;
    }
    if (append) {
        const loadMoreBtn = document.getElementById('btn-load-more');
        if (loadMoreBtn) {
            loadMoreBtn.disabled = true;
            loadMoreBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('loading')}`;
        }
    }

    try {
        const resp = await fetch('/api/inbox/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, offset: reqOffset, limit: PAGE_SIZE })
        });
        const data = await resp.json();

        if (!data.success) {
            if (!silent) {
                errorDiv.textContent = data.message;
                errorDiv.style.display = 'block';
                mailList.innerHTML = `
                            <div class="error-state">
                                <i class="bi bi-exclamation-triangle d-block"></i>
                                <p>${_escapeHtml(data.message || t('queryFailed'))}</p>
                            </div>`;
            }
            return;
        }

        currentEmail = email;
        currentTotal = data.total || 0;
        isSearchMode = false;
        if (!silent) {
            rememberMailbox(email);
            closeLeftDrawer();
        }
        _syncListHeader(currentTab);

        if (append) {
            // 追加模式：合并新消息到已有列表
            currentMessages = currentMessages.concat(data.messages);
        } else {
            currentMessages = data.messages;
        }

        document.getElementById('btn-refresh-mail').disabled = false;
        currentSentMessages = [];
        currentTrashMessages = [];
        if (currentTab === 'inbox') {
            document.getElementById('search-bar').style.display = 'flex';
        }

        // 静默刷新时保存当前选中和 checkbox 状态
        let activeId = null;
        let checkedIds = [];
        if (silent) {
            const activeEl = document.querySelector('.mail-item.active');
            if (activeEl) activeId = activeEl.dataset.msgId;
            checkedIds = getSelectedIds();
        }

        renderMessages(currentMessages);

        // 恢复选中和 checkbox 状态
        if (silent || append) {
            if (activeId) {
                const el = document.querySelector(`.mail-item[data-msg-id="${activeId}"]`);
                if (el) el.classList.add('active');
            }
            if (checkedIds.length > 0) {
                checkedIds.forEach(id => {
                    const cb = document.querySelector(`.mail-checkbox[value="${id}"]`);
                    if (cb) cb.checked = true;
                });
                updateBatchButtons();
            }
        }

    } catch (e) {
        if (!silent) {
            errorDiv.textContent = t('networkError') + ': ' + e.message;
            errorDiv.style.display = 'block';
            mailList.innerHTML = `
                        <div class="error-state">
                            <i class="bi bi-exclamation-triangle d-block"></i>
                            <p>${t('networkError')}: ${_escapeHtml(e.message)}</p>
                        </div>`;
        }
    } finally {
        if (!silent) {
            btn.disabled = false;
            btn.innerHTML = `<i class="bi bi-search me-1"></i>${t('query')}`;
        }
    }
}

function renderMessages(messages) {
    const mailList = document.getElementById('mail-list');
    const batchBar = document.getElementById('batch-bar');

    // 显示/隐藏批量操作栏
    if (messages.length > 0 && currentTab === 'inbox') {
        batchBar.style.display = 'flex';
        batchBar.style.cssText = 'display:flex !important;';
    } else {
        batchBar.style.cssText = 'display:none !important;';
    }
    // 重置全选
    document.getElementById('select-all-checkbox').checked = false;
    updateBatchButtons();

    if (messages.length === 0) {
        mailList.innerHTML = `
                    <div class="empty-state">
                        <i class="bi bi-inbox d-block"></i>
                        <p>${t('inboxEmpty')}</p>
                        <button class="btn-refresh" onclick="queryInbox()">
                            <i class="bi bi-arrow-clockwise"></i>${t('refresh')}
                        </button>
                    </div>`;
        return;
    }

    mailList.innerHTML = messages.map(msg => `
                <div class="card mb-2 mail-item ${msg.seen ? '' : 'mail-unread'}" data-msg-id="${msg.id}">
                    <div class="card-body py-2">
                        <div class="d-flex align-items-start">
                            <div class="form-check me-2 mt-1" onclick="event.stopPropagation()">
                                <input class="form-check-input mail-checkbox" type="checkbox" value="${msg.id}" onchange="updateBatchButtons()">
                            </div>
                            <div class="flex-grow-1 mail-item-body" onclick="viewMailDetail('${msg.id}', this.closest('.mail-item'))">
                                <div class="d-flex justify-content-between align-items-start">
                                    <span class="mail-sender text-truncate me-2"><span class="mail-copy">${_escapeHtml(msg.from?.name || msg.from?.address || t('unknownSender'))}</span></span>
                                    <div class="mail-item-meta text-end ms-2">
                                        ${msg.extracted_code ? `<button type="button" class="badge bg-success me-1 code-badge" title="${t('copyCode')}" onclick="copyText('${msg.extracted_code}', event)"><i class="bi bi-clipboard me-1"></i>${msg.extracted_code}</button>` : ''}
                                        <small class="text-muted mail-time" title="${_fullDate(msg.createdAt)}">${_shortDate(msg.createdAt)}</small>
                                    </div>
                                </div>
                                <div class="mail-subject text-truncate"><span class="mail-copy">${_escapeHtml(msg.subject || t('noSubject'))}</span></div>
                                <small class="mail-intro text-muted text-truncate d-block"><span class="mail-copy">${_escapeHtml(msg.intro || '')}</span></small>
                            </div>
                        </div>
                    </div>
                </div>
            `).join('');

    // 添加"加载更多"按钮（搜索结果不分页，否则会把搜索结果顶掉）
    if (!isSearchMode && currentTotal > currentMessages.length && currentTab === 'inbox') {
        mailList.insertAdjacentHTML('beforeend', `
                    <div class="text-center py-3">
                        <button class="btn btn-outline-primary btn-sm" id="btn-load-more" onclick="queryInbox(false, true)">
                            <i class="bi bi-arrow-down-circle me-1"></i>${t('loadMore')} (${currentMessages.length}/${currentTotal})
                        </button>
                    </div>`);
    }
    _updateUnreadBadge();
}

async function searchMail() {
    if (!currentEmail) return;
    const query = document.getElementById('search-input').value.trim();
    if (!query) { clearSearch(); return; }

    const mailList = document.getElementById('mail-list');
    mailList.innerHTML = `<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> ${t('searching')}</div>`;

    try {
        const resp = await fetch('/api/inbox/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, query })
        });
        const data = await resp.json();
        if (data.success) {
            isSearchMode = true;
            renderMessages(data.messages);
            if (data.messages.length === 0) {
                mailList.innerHTML = `
                            <div class="empty-state">
                                <i class="bi bi-search d-block"></i>
                                <p>${t('noMatch')}</p>
                                <button class="btn-refresh" onclick="clearSearch()">
                                    <i class="bi bi-x-lg"></i>${t('clearSearchBtn')}
                                </button>
                            </div>`;
            }
        } else {
            mailList.innerHTML = `<div class="error-state"><p>${_escapeHtml(data.message || t('searchFailed'))}</p></div>`;
        }
    } catch (e) {
        mailList.innerHTML = `<div class="error-state"><p>${t('searchFailed')}: ${_escapeHtml(e.message)}</p></div>`;
    }
}

function clearSearch() {
    document.getElementById('search-input').value = '';
    isSearchMode = false;
    renderMessages(currentMessages);
}

// ---- 邮件详情辅助 ----

function _addressText(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    return entry.address || entry.name || '';
}

function _renderAddressList(list) {
    const entries = (Array.isArray(list) ? list : []).map(_addressText).filter(Boolean);
    if (entries.length === 0) return '';
    return entries.map(addr => {
        // 泛解析邮箱下，标出这封信究竟是发给哪个别名的
        const isSelf = currentEmail && addr.toLowerCase() === currentEmail.toLowerCase();
        return `<span class="${isSelf ? 'detail-self-address' : ''}">${_escapeHtml(addr)}</span>`;
    }).join(', ');
}

function _fullDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US');
}

// 列表里的短时间：今天只显示时:分，今年显示月/日，更早带年份
function _shortDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    const locale = currentLang === 'zh' ? 'zh-CN' : 'en-US';
    const opts = currentLang === 'zh' ? { month: 'numeric', day: 'numeric' } : { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(locale, opts);
}

function _detailMetaRow(label, valueHtml) {
    if (!valueHtml) return '';
    return `<div class="detail-meta-row"><span class="detail-meta-label">${label}:</span><span class="detail-meta-value">${valueHtml}</span></div>`;
}

function _detailActions(messageId, isTrash) {
    if (isTrash) {
        return `
                    <button class="btn btn-sm btn-outline-primary" onclick="restoreEmail('${messageId}')" title="${t('restore')}" aria-label="${t('restore')}">
                        <i class="bi bi-arrow-counterclockwise"></i><span class="btn-label">${t('restore')}</span>
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="permanentDeleteEmail('${messageId}')" title="${t('permanentDelete')}" aria-label="${t('permanentDelete')}">
                        <i class="bi bi-x-circle"></i><span class="btn-label">${t('permanentDelete')}</span>
                    </button>`;
    }
    return `
                <button class="btn btn-sm btn-outline-primary" onclick="openReply()" title="${t('reply')}" aria-label="${t('reply')}">
                    <i class="bi bi-reply"></i><span class="btn-label">${t('reply')}</span>
                </button>
                <button class="btn btn-sm btn-outline-primary" onclick="openReplyAll()" title="${t('replyAll')}" aria-label="${t('replyAll')}">
                    <i class="bi bi-reply-all"></i><span class="btn-label">${t('replyAll')}</span>
                </button>
                <button class="btn btn-sm btn-outline-secondary" onclick="openForward()" title="${t('forward')}" aria-label="${t('forward')}">
                    <i class="bi bi-arrow-right-short"></i><span class="btn-label">${t('forward')}</span>
                </button>
                <button class="btn btn-sm btn-outline-secondary" id="btn-toggle-plain" onclick="togglePlainText()" title="${t('viewPlain')}" aria-label="${t('viewPlain')}">
                    <i class="bi bi-file-text"></i><span class="btn-label">${t('viewPlain')}</span>
                </button>
                <button class="btn btn-sm btn-outline-secondary" onclick="downloadEml('${messageId}')" title="${t('downloadEml')}" aria-label="${t('downloadEml')}">
                    <i class="bi bi-download"></i><span class="btn-label">${t('downloadEml')}</span>
                </button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteEmail('${messageId}')" title="${t('delete')}" aria-label="${t('delete')}">
                    <i class="bi bi-trash"></i><span class="btn-label">${t('delete')}</span>
                </button>`;
}

function togglePlainText() {
    const htmlBox = document.getElementById('mail-body-html');
    const plainBox = document.getElementById('mail-body-plain');
    const btn = document.getElementById('btn-toggle-plain');
    if (!htmlBox || !plainBox) return;
    const showPlain = plainBox.style.display === 'none';
    plainBox.style.display = showPlain ? 'block' : 'none';
    htmlBox.style.display = showPlain ? 'none' : 'block';
    if (btn) {
        const key = showPlain ? 'viewHtml' : 'viewPlain';
        btn.innerHTML = `<i class="bi ${showPlain ? 'bi-code-slash' : 'bi-file-text'}"></i><span class="btn-label">${t(key)}</span>`;
        btn.title = t(key);
        btn.setAttribute('aria-label', t(key));
    }
}

async function downloadEml(messageId) {
    const filename = `${(window._currentDetailMsg?.subject || messageId).slice(0, 60).replace(/[\\/:*?"<>|]/g, '_')}.eml`;
    const url = `/api/inbox/source/${encodeURIComponent(messageId)}?email=${encodeURIComponent(currentEmail)}&filename=${encodeURIComponent(filename)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            toastError(resp.status === 404 ? t('emlUnavailable') : t('loadFailed'));
            return;
        }
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (e) {
        toastError(t('networkError') + ': ' + e.message);
    }
}

async function viewMailDetail(messageId, element, isTrash = false) {
    if (!currentEmail) return;

    document.querySelectorAll('.mail-item').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');
    showMailDetailView();

    const detailContent = document.getElementById('mail-detail-content');

    detailContent.innerHTML = `
                <div class="mb-3"><div class="skeleton skeleton-text" style="width:50%"></div></div>
                <div class="mb-3"><div class="skeleton skeleton-text" style="width:70%"></div></div>
                <div class="mb-3"><div class="skeleton skeleton-text" style="width:40%"></div></div>
                <hr>
                <div style="background:#f8f9fa; padding:15px; border-radius:8px;">
                    <div class="skeleton skeleton-text mb-2" style="width:90%"></div>
                    <div class="skeleton skeleton-text mb-2" style="width:85%"></div>
                    <div class="skeleton skeleton-text" style="width:60%"></div>
                </div>`;

    try {
        const resp = await fetch('/api/inbox/detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                email: currentEmail, 
                message_id: messageId 
            })
        });
        const data = await resp.json();

        if (!data.success) {
            detailContent.innerHTML = `
                        <div class="error-state">
                            <i class="bi bi-exclamation-triangle d-block"></i>
                            <p>${_escapeHtml(data.message || t('loadFailed'))}</p>
                        </div>`;
            return;
        }

        const msg = data.detail;
        // 保存当前查看的邮件详情供回复使用
        window._currentDetailMsg = msg;
        // 同步已读状态：更新 currentMessages 并移除未读样式
        const idx = currentMessages.findIndex(m => m.id === messageId);
        if (!isTrash && idx !== -1) currentMessages[idx].seen = true;
        if (!isTrash && element) element.classList.remove('mail-unread');
        _updateUnreadBadge();
        const fromName = _escapeHtml(msg.from?.name || '');
        const fromAddr = _escapeHtml(msg.from?.address || '');
        const fromHtml = fromName ? `${fromName} &lt;${fromAddr}&gt;` : fromAddr;
        const codeHtml = msg.extracted_code
            ? `<button type="button" class="badge bg-success code-badge" title="${t('copyCode')}" onclick="copyText('${msg.extracted_code}', event)"><i class="bi bi-clipboard me-1"></i>${msg.extracted_code}</button>`
            : '';

        detailContent.innerHTML = `
                    <div class="detail-actions mb-3">${_detailActions(messageId, isTrash)}</div>
                    ${_detailMetaRow(t('from'), fromHtml)}
                    ${_detailMetaRow(t('to'), _renderAddressList(msg.to))}
                    ${_detailMetaRow(t('cc'), _renderAddressList(msg.cc))}
                    ${_detailMetaRow(t('subject'), _escapeHtml(msg.subject || t('noSubject')))}
                    ${_detailMetaRow(t('time'), new Date(msg.createdAt).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US'))}
                    ${codeHtml ? _detailMetaRow(t('verifyCode'), codeHtml) : ''}
                    ${_renderAttachments(messageId, msg.attachments)}
                    <hr>
                    <div class="mail-body-container" id="mail-body-html" style="background:#fff; padding:0; overflow:hidden;">
                        <iframe id="mail-body-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" style="width:100%;border:none;min-height:200px;"></iframe>
                    </div>
                    <pre id="mail-body-plain" class="mail-plaintext" style="display:none;background:#f8f9fa;border-radius:8px;"></pre>
                `;
        document.getElementById('mail-body-plain').textContent = msg.text || t('emptyContent');
        // 安全渲染邮件内容到 iframe sandbox
        const iframe = document.getElementById('mail-body-frame');
        const mailContent = msg.html || _escapeHtml(msg.text || '').replace(/\n/g, '<br>') || `<i style="color:#6c757d;">${t('emptyContent')}</i>`;
        _renderMailBodyIframe(iframe, mailContent);

    } catch (e) {
        detailContent.innerHTML = `<div class="alert alert-danger">${t('loadFailed')}: ${e.message}</div>`;
    }
}

// ---- 撰写 / 回复 / 发送邮件 ----

let composeModal = null;
let quillEditor = null;

function _getComposeModal() {
    if (!composeModal) {
        composeModal = new bootstrap.Modal(document.getElementById('composeModal'));
    }
    return composeModal;
}

function _getQuillEditor() {
    if (!quillEditor) {
        quillEditor = new Quill('#compose-editor', {
            theme: 'snow',
            placeholder: t('editorPlaceholder'),
            modules: {
                toolbar: [
                    [{ 'header': [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ 'color': [] }, { 'background': [] }],
                    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                    ['blockquote', 'code-block'],
                    ['link', 'image'],
                    ['clean'],
                ],
            },
        });
        quillEditor.on('text-change', saveDraft);
    }
    return quillEditor;
}

function _syncComposeDomains() {
    const sel = document.getElementById('compose-from-domain');
    const prev = sel.value;
    sel.innerHTML = activeDomains.map(d => `<option value="${d}">${d}</option>`).join('');
    if (activeDomains.includes(prev)) sel.value = prev;
}

// ---- 收件人 chip 输入 ----
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
let recipients = [];

function renderRecipients() {
    const wrap = document.getElementById('compose-to-chips');
    const input = document.getElementById('compose-to-input');
    wrap.querySelectorAll('.chip').forEach(el => el.remove());
    recipients.forEach((addr, index) => {
        const chip = document.createElement('span');
        chip.className = 'chip' + (EMAIL_RE.test(addr) ? '' : ' chip-invalid');
        const text = document.createElement('span');
        text.className = 'chip-text';
        text.textContent = addr;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-remove';
        remove.innerHTML = '<i class="bi bi-x-lg"></i>';
        remove.onclick = (e) => { e.stopPropagation(); recipients.splice(index, 1); renderRecipients(); saveDraft(); };
        chip.appendChild(text);
        chip.appendChild(remove);
        wrap.insertBefore(chip, input);
    });
}

function addRecipients(raw) {
    const parts = String(raw || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    let added = false;
    parts.forEach(addr => {
        if (!recipients.some(x => x.toLowerCase() === addr.toLowerCase())) {
            recipients.push(addr);
            added = true;
        }
    });
    if (added) { renderRecipients(); saveDraft(); }
}

function setRecipients(list) {
    recipients = [];
    (list || []).filter(Boolean).forEach(addr => {
        if (!recipients.some(x => x.toLowerCase() === addr.toLowerCase())) recipients.push(addr);
    });
    renderRecipients();
}

function focusRecipientInput(event) {
    if (event && event.target.closest('.chip')) return;
    document.getElementById('compose-to-input').focus();
}

function _initRecipientInput() {
    const wrap = document.getElementById('compose-to-chips');
    const input = document.getElementById('compose-to-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
            e.preventDefault();
            addRecipients(input.value);
            input.value = '';
        } else if (e.key === 'Backspace' && !input.value && recipients.length > 0) {
            recipients.pop();
            renderRecipients();
            saveDraft();
        }
    });
    input.addEventListener('blur', () => {
        if (input.value.trim()) { addRecipients(input.value); input.value = ''; }
        wrap.classList.remove('is-focused');
    });
    input.addEventListener('focus', () => wrap.classList.add('is-focused'));
    input.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (text && /[,;\s]/.test(text)) {
            e.preventDefault();
            addRecipients(text);
        }
    });
}

// ---- 附件 ----
let composeAttachments = [];

function _totalAttachmentBytes() {
    return composeAttachments.reduce((sum, a) => sum + a.size, 0);
}

function renderAttachmentChips() {
    const wrap = document.getElementById('compose-attachments');
    wrap.innerHTML = '';
    composeAttachments.forEach((att, index) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const text = document.createElement('span');
        text.className = 'chip-text';
        text.textContent = `${att.filename} (${_formatSize(att.size)})`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-remove';
        remove.innerHTML = '<i class="bi bi-x-lg"></i>';
        remove.onclick = () => { composeAttachments.splice(index, 1); renderAttachmentChips(); };
        chip.appendChild(text);
        chip.appendChild(remove);
        wrap.appendChild(chip);
    });
    const hint = document.getElementById('attachment-hint');
    hint.textContent = composeAttachments.length
        ? t('attachmentSummary', { n: composeAttachments.length, size: _formatSize(_totalAttachmentBytes()) })
        : '';
}

function _readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
    });
}

async function onAttachmentsPicked(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    for (const file of files) {
        if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
            toastError(t('attachmentTooLarge', { name: file.name, max: MAX_ATTACHMENT_MB }));
            continue;
        }
        if (_totalAttachmentBytes() + file.size > MAX_ATTACHMENT_TOTAL_MB * 1024 * 1024) {
            toastError(t('attachmentTotalTooLarge', { max: MAX_ATTACHMENT_TOTAL_MB }));
            break;
        }
        try {
            const content = await _readFileAsBase64(file);
            composeAttachments.push({
                filename: file.name,
                size: file.size,
                contentType: file.type || '',
                content,
            });
            renderAttachmentChips();
        } catch (e) {
            toastError(t('attachmentReadFailed', { name: file.name }));
        }
    }
}

// ---- 草稿（附件不入草稿，base64 太大会撑爆 localStorage） ----
let draftTimer = null;
let composeVisible = false;

function _composeIsDirty() {
    const subject = document.getElementById('compose-subject').value.trim();
    const body = _getQuillEditor().getText().trim();
    return Boolean(recipients.length || subject || body || composeAttachments.length);
}

function saveDraft() {
    if (!composeVisible) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        if (!_composeIsDirty()) { discardDraft(true); return; }
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify({
                fromPrefix: document.getElementById('compose-from-prefix').value,
                fromDomain: document.getElementById('compose-from-domain').value,
                recipients,
                subject: document.getElementById('compose-subject').value,
                html: _getQuillEditor().root.innerHTML,
                title: document.getElementById('composeModalLabel').textContent,
            }));
        } catch (e) {}
    }, 400);
}

function _loadDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function discardDraft(silent = false) {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    if (!silent) document.getElementById('compose-draft-bar').style.display = 'none';
}

function restoreDraft() {
    const draft = _loadDraft();
    if (!draft) return;
    document.getElementById('compose-from-prefix').value = draft.fromPrefix || '';
    const domainSel = document.getElementById('compose-from-domain');
    if (activeDomains.includes(draft.fromDomain)) domainSel.value = draft.fromDomain;
    setRecipients(draft.recipients || []);
    document.getElementById('compose-subject').value = draft.subject || '';
    if (draft.html) _getQuillEditor().clipboard.dangerouslyPasteHTML(draft.html);
    document.getElementById('compose-draft-bar').style.display = 'none';
}

function _resetComposeForm() {
    document.getElementById('compose-from-prefix').value = '';
    document.getElementById('compose-subject').value = '';
    setRecipients([]);
    composeAttachments = [];
    renderAttachmentChips();
    document.getElementById('compose-to-input').value = '';
    _getQuillEditor().setContents([]);
    const alert = document.getElementById('compose-alert');
    alert.style.display = 'none';
    alert.className = 'alert';
    document.getElementById('compose-draft-bar').style.display = 'none';
    document.getElementById('btn-send-email').disabled = false;
    document.getElementById('btn-send-email').innerHTML = `<i class="bi bi-send me-1"></i>${t('send')}`;
    document.getElementById('composeModalLabel').innerHTML = `<i class="bi bi-pencil-square me-2"></i>${t('composeEmail')}`;
}

function _fillComposeSender() {
    if (!currentEmail) return;
    const [prefix, domain] = currentEmail.split('@');
    document.getElementById('compose-from-prefix').value = prefix || '';
    const domainSel = document.getElementById('compose-from-domain');
    if (activeDomains.includes(domain)) domainSel.value = domain;
}

function _showCompose() {
    composeVisible = true;
    _getComposeModal().show();
}

function tryCloseCompose() {
    if (!_composeIsDirty()) {
        _closeCompose(true);
        return;
    }
    showConfirm({
        title: t('discardTitle'),
        message: t('discardMsg'),
        okLabel: t('discardOk'),
        onConfirm: () => _closeCompose(true),
    });
}

function _closeCompose(clearDraft) {
    clearTimeout(draftTimer);
    composeVisible = false;
    if (clearDraft) discardDraft(true);
    _getComposeModal().hide();
}

function openCompose() {
    _resetComposeForm();
    _syncComposeDomains();
    _fillComposeSender();
    const draft = _loadDraft();
    if (draft) {
        document.getElementById('compose-draft-bar').style.display = 'flex';
    }
    _showCompose();
}

function _quoteOriginal(msg, origSubject) {
    const origDate = msg.createdAt ? new Date(msg.createdAt).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US') : '';
    const origFrom = msg.from?.address || '';
    const editor = _getQuillEditor();
    editor.setContents([]);
    editor.insertText(0, '\n\n');
    const quoteStart = editor.getLength();
    const quoteText = `--- Original Message ---\nFrom: ${origFrom}\nDate: ${origDate}\nSubject: ${origSubject}\n\n${msg.text || ''}`;
    editor.insertText(quoteStart, quoteText);
    editor.formatText(quoteStart, quoteText.length, 'color', '#6c757d');
    editor.setSelection(0, 0);
}

function _openComposeVariant({ iconClass, titleKey, toList, subjectPrefix }) {
    const msg = window._currentDetailMsg;
    if (!msg) return;

    _resetComposeForm();
    _syncComposeDomains();
    _fillComposeSender();
    document.getElementById('composeModalLabel').innerHTML = `<i class="bi ${iconClass} me-2"></i>${t(titleKey)}`;

    setRecipients(toList);

    const origSubject = msg.subject || '';
    document.getElementById('compose-subject').value =
        origSubject.startsWith(subjectPrefix) ? origSubject : `${subjectPrefix}${origSubject}`;

    _quoteOriginal(msg, origSubject);
    _showCompose();
}

function openReply() {
    const msg = window._currentDetailMsg;
    if (!msg) return;
    _openComposeVariant({
        iconClass: 'bi-reply',
        titleKey: 'replyEmail',
        toList: [msg.from?.address].filter(Boolean),
        subjectPrefix: 'Re: ',
    });
}

function openReplyAll() {
    const msg = window._currentDetailMsg;
    if (!msg) return;
    const self = (currentEmail || '').toLowerCase();
    const everyone = [msg.from?.address]
        .concat((msg.to || []).map(_addressText))
        .concat((msg.cc || []).map(_addressText))
        .filter(Boolean)
        .filter(addr => addr.toLowerCase() !== self);
    _openComposeVariant({
        iconClass: 'bi-reply-all',
        titleKey: 'replyAll',
        toList: everyone,
        subjectPrefix: 'Re: ',
    });
}

function openForward() {
    const msg = window._currentDetailMsg;
    if (!msg) return;
    _openComposeVariant({
        iconClass: 'bi-arrow-right-short',
        titleKey: 'forwardEmail',
        toList: [],
        subjectPrefix: 'Fwd: ',
    });
}

async function sendEmail() {
    const alertDiv = document.getElementById('compose-alert');
    const btn = document.getElementById('btn-send-email');
    alertDiv.style.display = 'none';

    const fromPrefix = document.getElementById('compose-from-prefix').value.trim();
    const fromDomain = document.getElementById('compose-from-domain').value;
    // 收件人输入框里还没成 chip 的内容也一并收进来
    const pending = document.getElementById('compose-to-input');
    if (pending.value.trim()) { addRecipients(pending.value); pending.value = ''; }
    const to = recipients.join(',');
    const subject = document.getElementById('compose-subject').value.trim();
    const editor = _getQuillEditor();
    const body = editor.getText().trim();
    const htmlBody = editor.root.innerHTML;

    if (!fromPrefix || !fromDomain) {
        alertDiv.className = 'alert alert-danger';
        alertDiv.textContent = t('fillFrom');
        alertDiv.style.display = 'block';
        return;
    }
    if (recipients.length === 0) {
        alertDiv.className = 'alert alert-danger';
        alertDiv.textContent = t('fillTo');
        alertDiv.style.display = 'block';
        return;
    }
    if (recipients.some(addr => !EMAIL_RE.test(addr))) {
        alertDiv.className = 'alert alert-danger';
        alertDiv.textContent = t('invalidRecipient');
        alertDiv.style.display = 'block';
        return;
    }
    if (!subject) {
        alertDiv.className = 'alert alert-danger';
        alertDiv.textContent = t('fillSubject');
        alertDiv.style.display = 'block';
        return;
    }
    if (!body) {
        alertDiv.className = 'alert alert-danger';
        alertDiv.textContent = t('fillBody');
        alertDiv.style.display = 'block';
        return;
    }

    const fromEmail = `${fromPrefix}@${fromDomain}`;

    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('sending')}`;

    try {
        const resp = await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from_email: fromEmail,
                from_name: fromPrefix,
                to: to,
                subject: subject,
                text: body,
                html: htmlBody,
                reply_to: fromEmail,
                attachments: composeAttachments.map(a => ({
                    filename: a.filename,
                    content: a.content,
                    contentType: a.contentType,
                })),
            })
        });
        const data = await resp.json();

        if (data.success) {
            alertDiv.className = 'alert alert-success';
            alertDiv.textContent = t('sentSuccess');
            alertDiv.style.display = 'block';
            btn.innerHTML = `<i class="bi bi-check-lg me-1"></i>${t('sent')}`;
            discardDraft(true);
            showToast(t('sentSuccess'), { type: 'success' });
            // 2秒后自动关闭弹窗
            setTimeout(() => { _closeCompose(true); }, 2000);
        } else {
            alertDiv.className = 'alert alert-danger';
            alertDiv.textContent = data.message || t('sendFailed');
            alertDiv.style.display = 'block';
            btn.disabled = false;
            btn.innerHTML = `<i class="bi bi-send me-1"></i>${t('send')}`;
        }
    } catch (e) {
        alertDiv.className = 'alert alert-danger';
        alertDiv.textContent = t('networkError') + ': ' + e.message;
        alertDiv.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-send me-1"></i>${t('send')}`;
    }
}

// ---- 批量操作 ----

function getSelectedIds() {
    return Array.from(document.querySelectorAll('.mail-checkbox:checked')).map(cb => cb.value);
}

function updateBatchButtons() {
    const ids = getSelectedIds();
    const count = ids.length;
    document.getElementById('btn-batch-delete').disabled = count === 0;
    document.getElementById('btn-batch-read').disabled = count === 0;
    document.getElementById('selected-count').textContent = count > 0 ? t('selected', {n: count}) : '';
}

function toggleSelectAll(checked) {
    document.querySelectorAll('.mail-checkbox').forEach(cb => { cb.checked = checked; });
    updateBatchButtons();
}

async function _batchRequest(action, ids) {
    const resp = await fetch('/api/inbox/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentEmail, action, message_ids: ids })
    });
    return resp.json();
}

// 撤销批量删除走一次 batch restore；上游若不支持这个 action 就引导去回收站
async function _undoBatchDelete(removed) {
    try {
        const data = await _batchRequest('restore', removed.map(m => m.id));
        if (!data.success) {
            toastError(t('undoFailed'));
            return;
        }
        currentMessages = currentMessages.concat(removed)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        renderMessages(currentMessages);
        showToast(t('mailRestored'), { type: 'success' });
    } catch (e) {
        toastError(t('undoFailed'));
    }
}

async function batchAction(action) {
    const ids = getSelectedIds();
    if (ids.length === 0) return;

    try {
        const data = await _batchRequest(action, ids);
        if (!data.success) {
            toastError(data.message || t('deleteFailed'));
            return;
        }
        if (action === 'delete') {
            // 直接删（软删除），用 Toast 给撤销入口，省掉每次确认弹窗
            const removed = currentMessages.filter(m => ids.includes(m.id));
            currentMessages = currentMessages.filter(m => !ids.includes(m.id));
            renderMessages(currentMessages);
            resetMailDetail();
            showToast(t('mailsDeleted', { n: ids.length }), {
                actionLabel: t('undo'),
                onAction: () => _undoBatchDelete(removed),
            });
        } else if (action === 'mark_read') {
            // 本地更新已读状态，避免不必要的网络请求
            ids.forEach(id => {
                const m = currentMessages.find(msg => msg.id === id);
                if (m) m.seen = true;
            });
            renderMessages(currentMessages);
            _updateUnreadBadge();
            showToast(t('markedRead'), { type: 'success' });
        }
    } catch (e) {
        toastError(t('networkError') + ': ' + e.message);
    }
}

function batchDelete() { return batchAction('delete'); }
function batchMarkRead() { return batchAction('mark_read'); }

// ---- 删除邮件 ----

async function _undoSingleDelete(msg) {
    try {
        const resp = await fetch('/api/inbox/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, message_id: msg.id })
        });
        const data = await resp.json();
        if (!data.success) {
            toastError(t('undoFailed'));
            return;
        }
        currentMessages = currentMessages.concat([msg])
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        renderMessages(currentMessages);
        showToast(t('mailRestored'), { type: 'success' });
    } catch (e) {
        toastError(t('undoFailed'));
    }
}

async function deleteEmail(messageId) {
    if (!currentEmail) return;

    try {
        const resp = await fetch('/api/inbox/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: currentEmail,
                message_id: messageId,
            })
        });
        const data = await resp.json();

        if (data.success) {
            const removed = currentMessages.find(m => m.id === messageId);
            currentMessages = currentMessages.filter(m => m.id !== messageId);
            renderMessages(currentMessages);
            resetMailDetail();
            showToast(t('mailDeleted'), removed ? {
                actionLabel: t('undo'),
                onAction: () => _undoSingleDelete(removed),
            } : {});
        } else {
            toastError(data.message || t('deleteFailed'));
        }
    } catch (e) {
        toastError(t('networkError') + ': ' + e.message);
    }
}

function restoreEmail(messageId) {
    if (!currentEmail) return;
    // 恢复是可逆动作，直接执行
    trashAction('/api/inbox/restore', messageId, t('mailRestored'));
}

function permanentDeleteEmail(messageId) {
    if (!currentEmail) return;
    // 彻底删除不可逆，保留确认
    showConfirm({
        title: t('permanentDelete'),
        message: t('confirmPermanentDelete'),
        okLabel: t('permanentDeleteOk'),
        onConfirm: () => trashAction('/api/inbox/permanent-delete', messageId, t('permanentDelete')),
    });
}

async function trashAction(url, messageId, okMessage) {
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, message_id: messageId })
        });
        const data = await resp.json();
        if (data.success) {
            currentTrashMessages = currentTrashMessages.filter(m => m.id !== messageId);
            renderTrashMessages(currentTrashMessages);
            resetMailDetail();
            showToast(okMessage, { type: 'success' });
        } else {
            toastError(data.message || t('deleteFailed'));
        }
    } catch (e) {
        toastError(t('networkError') + ': ' + e.message);
    }
}
