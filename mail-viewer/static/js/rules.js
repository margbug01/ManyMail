// 转发与推送规则页：列表、编辑器、试运行、测试推送、最近路由记录。数据经 /api/router/* 转给 mail-router。
(function () {
    'use strict';

    const LANG = (localStorage.getItem('manymail-lang') || 'zh') === 'en' ? 'en' : 'zh';
    const TEXT = {
        zh: {
            noRules: '还没有规则。点「新建规则」开始。',
            fromEnv: '来自 .env',
            invalid: '无效',
            all: '全部邮件',
            imapOnly: '仅外部 IMAP',
            smtpImap: '本站 + 外部 IMAP',
            edit: '编辑', view: '查看', del: '删除', test: '测试推送',
            newTitle: '新建规则', editTitle: '编辑规则',
            confirmDelete: '删除规则「{name}」？',
            matched: '最近 {checked} 封里命中 {n} 封',
            noMatch: '没有命中。',
            testNone: '这条规则没有推送类动作（ntfy / Telegram / webhook）。',
            testTitle: '测试推送结果',
            noStatus: '还没有路由记录。',
            loadFailed: '加载失败：',
            saveFailed: '保存失败：',
            nameRequired: '先填名称',
            remove: '移除',
            stopChip: '命中后停止',
            labels: { to: '收件人', from: '发件人', subject: '主题', body: '正文', subject_regex: '主题正则', has_attachments: '附件', include_spam: '含垃圾邮件', source: '来源' },
            types: { forward: '转发', ntfy: 'ntfy 推送', telegram: 'Telegram', webhook: 'Webhook', tag: '打标签', mark_read: '标为已读', trash: '丢进垃圾箱' },
            fields: {
                forward: { to: '转发到（多个用逗号分隔）', from: '发件人（Resend 已验证域名下的地址）', subject_prefix: '主题前缀（可选）', api_key_env: 'Resend key 所在的环境变量（默认 RESEND_API_KEY）' },
                ntfy: { topic: 'Topic（公共服务器上任何人知道名字就能订阅，用长一点的随机名）', server: '服务器（默认 https://ntfy.sh）', priority: '优先级', token_env: '访问令牌所在的环境变量（可选）' },
                telegram: { chat_id: 'Chat ID', bot_token_env: 'Bot token 所在的环境变量（默认 TELEGRAM_BOT_TOKEN）' },
                webhook: { url: 'URL', secret_env: '签名密钥所在的环境变量（可选，HMAC-SHA256）' },
                tag: { tags: '标签（逗号分隔）' },
            },
            priority: ['默认', '1 最低', '2 低', '3 普通', '4 高', '5 紧急'],
            yes: '有', no: '无',
            statuses: { done: '完成', retry: '重试中', running: '处理中', failed: '失败' },
        },
        en: {
            title: 'Forwarding & push rules', back: 'Back to mail', newRule: 'New rule',
            intro: 'Rules are checked in order when new mail arrives; matching rules forward it, push it to your phone, tag it, mark it read or trash it. New mail in external IMAP accounts can only be pushed.',
            on: 'On', rule: 'Rule', actions: 'Actions', order: 'Order', loading: 'Loading...', recent: 'Recently routed',
            editRule: 'Edit rule', readonly: 'This rule comes from the FORWARD_* variables in .env and can only be changed there.',
            name: 'Name', stop: 'Stop after match',
            when: 'Conditions (every filled field must match; inside a field any entry may match, separate with commas or new lines)',
            source: 'Source', srcSmtp: 'Mail received here', srcImap: 'New mail in external IMAP accounts',
            to: 'Recipients (* wildcards, e.g. *@example.com)', from: 'Senders (* wildcards)', subject: 'Subject contains',
            body: 'Body contains', regex: 'Subject regex (optional)', attach: 'Attachments', any: 'Any',
            withAttach: 'With attachments', noAttach: 'Without attachments', spam: 'Include spam', do: 'Actions',
            dryRun: 'Dry run on the last 100', testPush: 'Send test push', cancel: 'Cancel', save: 'Save',
            noRules: 'No rules yet. Click "New rule" to add one.',
            fromEnv: 'from .env', invalid: 'invalid', all: 'all mail', imapOnly: 'external IMAP only',
            smtpImap: 'here + external IMAP',
            edit: 'Edit', view: 'View', del: 'Delete', test: 'Test push',
            newTitle: 'New rule', editTitle: 'Edit rule',
            confirmDelete: 'Delete rule "{name}"?',
            matched: '{n} of the last {checked} messages match',
            noMatch: 'Nothing matches.',
            testNone: 'This rule has no push actions (ntfy / Telegram / webhook).',
            testTitle: 'Test push results',
            noStatus: 'Nothing routed yet.',
            loadFailed: 'Could not load: ', saveFailed: 'Could not save: ', nameRequired: 'Give the rule a name first',
            remove: 'Remove', stopChip: 'stops',
            labels: { to: 'to', from: 'from', subject: 'subject', body: 'body', subject_regex: 'subject regex', has_attachments: 'attachments', include_spam: 'incl. spam', source: 'source' },
            types: { forward: 'Forward', ntfy: 'ntfy push', telegram: 'Telegram', webhook: 'Webhook', tag: 'Tag', mark_read: 'Mark read', trash: 'Trash' },
            fields: {
                forward: { to: 'Forward to (comma separated)', from: 'From (an address on a Resend-verified domain)', subject_prefix: 'Subject prefix (optional)', api_key_env: 'Env variable holding the Resend key (default RESEND_API_KEY)' },
                ntfy: { topic: 'Topic (anyone who knows it can subscribe on the public server; use a long random name)', server: 'Server (default https://ntfy.sh)', priority: 'Priority', token_env: 'Env variable holding an access token (optional)' },
                telegram: { chat_id: 'Chat ID', bot_token_env: 'Env variable holding the bot token (default TELEGRAM_BOT_TOKEN)' },
                webhook: { url: 'URL', secret_env: 'Env variable holding the signing secret (optional, HMAC-SHA256)' },
                tag: { tags: 'Tags (comma separated)' },
            },
            priority: ['Default', '1 min', '2 low', '3 normal', '4 high', '5 urgent'],
            yes: 'yes', no: 'no',
            statuses: { done: 'done', retry: 'retrying', running: 'running', failed: 'failed' },
        },
    };
    const T = Object.assign({}, TEXT.zh, LANG === 'en' ? TEXT.en : {});
    const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));

    // 每种动作的字段：[key, kind]；kind = text | list | env | priority
    const ACTION_FIELDS = {
        forward: [['to', 'list'], ['from', 'text'], ['subject_prefix', 'text'], ['api_key_env', 'env']],
        ntfy: [['topic', 'text'], ['server', 'text'], ['priority', 'priority'], ['token_env', 'env']],
        telegram: [['chat_id', 'text'], ['bot_token_env', 'env']],
        webhook: [['url', 'text'], ['secret_env', 'env']],
        tag: [['tags', 'list']],
        mark_read: [],
        trash: [],
    };
    const NOTIFY = ['ntfy', 'telegram', 'webhook'];

    const $ = (id) => document.getElementById(id);
    let rules = [];
    let editing = null;   // 正在编辑的规则 id；null 表示新建
    let modal = null;

    function el(tag, attrs, children) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => {
            if (v === undefined || v === null || v === false) return;
            if (k === 'text') node.textContent = v;
            else if (k === 'className') node.className = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : v);
        });
        (children || []).forEach((c) => c && node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
        return node;
    }

    const splitList = (value) => String(value || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const asList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]));

    async function api(method, path, body) {
        const opts = { method, headers: {}, credentials: 'same-origin' };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const resp = await fetch('/api/router/' + path, opts);
        if (resp.redirected && new URL(resp.url).pathname === '/login') {
            location.href = '/login';
            throw new Error('login required');
        }
        let data = {};
        try { data = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }
        if (!resp.ok) {
            const err = new Error(data.error || data.message || ('HTTP ' + resp.status));
            err.problems = data.problems || [];
            throw err;
        }
        return data;
    }

    function showError(box, err, prefix) {
        box.replaceChildren(el('div', { text: (prefix || '') + err.message }));
        if (err.problems && err.problems.length) {
            box.appendChild(el('ul', { className: 'mb-0 mt-1 small' }, err.problems.map((p) => el('li', { text: p }))));
        }
        box.classList.remove('d-none');
    }

    // ---- 列表 ------------------------------------------------------------------------

    function matchSummary(match) {
        const parts = [];
        ['to', 'from', 'subject', 'body'].forEach((k) => {
            const items = asList(match[k]);
            if (items.length) parts.push(T.labels[k] + ': ' + items.join(', '));
        });
        if (match.subject_regex) parts.push(T.labels.subject_regex + ': ' + match.subject_regex);
        if (match.has_attachments === true || match.has_attachments === false) {
            parts.push(T.labels.has_attachments + ': ' + (match.has_attachments ? T.yes : T.no));
        }
        if (match.include_spam) parts.push(T.labels.include_spam);
        const sources = asList(match.source);
        if (sources.includes('imap')) parts.push(T.labels.source + ': ' + (sources.includes('smtp') ? T.smtpImap : T.imapOnly));
        return parts.length ? parts.join(' · ') : T.all;
    }

    function renderRules() {
        const body = $('rules-body');
        if (!rules.length) {
            body.replaceChildren(el('tr', {}, [el('td', { colspan: '5', className: 'empty', text: T.noRules })]));
            return;
        }
        body.replaceChildren(...rules.map((rule) => {
            const fromEnv = rule.managed_by === 'env';
            const enabled = rule.enabled !== false;
            const toggle = el('input', {
                className: 'form-check-input', type: 'checkbox', role: 'switch', checked: enabled,
                disabled: fromEnv, 'aria-label': T.on,
                onchange: async (e) => {
                    try {
                        await api('POST', 'rules/' + encodeURIComponent(rule._id) + '/enabled', { enabled: e.target.checked });
                        await loadRules();
                    } catch (err) {
                        e.target.checked = !e.target.checked;
                        showError($('rules-error'), err, T.saveFailed);
                    }
                },
            });
            const chips = [];
            if (fromEnv) chips.push(el('span', { className: 'chip chip-env', text: T.fromEnv }));
            if (rule.stop) chips.push(el('span', { className: 'chip chip-env', text: T.stopChip }));
            if (rule.problems && rule.problems.length) {
                chips.push(el('span', { className: 'chip chip-bad', text: T.invalid, title: rule.problems.join('\n') }));
            }
            const hasNotify = (rule.actions || []).some((a) => NOTIFY.includes(a.type));
            const buttons = el('div', { className: 'd-flex gap-1 justify-content-end' }, [
                el('button', { className: 'btn btn-sm btn-outline-secondary', type: 'button', title: fromEnv ? T.view : T.edit, onclick: () => openEditor(rule) },
                    [el('i', { className: fromEnv ? 'bi bi-eye' : 'bi bi-pencil' })]),
                hasNotify ? el('button', { className: 'btn btn-sm btn-outline-secondary', type: 'button', title: T.test, onclick: () => testSaved(rule) },
                    [el('i', { className: 'bi bi-bell' })]) : null,
                fromEnv ? null : el('button', { className: 'btn btn-sm btn-outline-danger', type: 'button', title: T.del, onclick: () => removeRule(rule) },
                    [el('i', { className: 'bi bi-trash' })]),
            ]);
            return el('tr', { className: 'rule-row' + (enabled ? '' : ' rule-off') }, [
                el('td', {}, [el('div', { className: 'form-check form-switch mb-0' }, [toggle])]),
                el('td', {}, [
                    el('div', {}, [el('strong', { text: rule.name || rule._id }), ' ', ...chips]),
                    el('div', { className: 'match-text', text: matchSummary(rule.match || {}) }),
                ]),
                el('td', {}, (rule.actions || []).map((a) => el('span', { className: 'chip', text: T.types[a.type] || a.type }))),
                el('td', { text: String(rule.order !== undefined ? rule.order : 100) }),
                el('td', {}, [buttons]),
            ]);
        }));
    }

    async function loadRules() {
        try {
            rules = (await api('GET', 'rules')).rules || [];
            $('rules-error').classList.add('d-none');
            renderRules();
        } catch (err) {
            $('rules-body').replaceChildren();
            showError($('rules-error'), err, T.loadFailed);
        }
    }

    async function removeRule(rule) {
        if (!confirm(fmt(T.confirmDelete, { name: rule.name || rule._id }))) return;
        try {
            await api('DELETE', 'rules/' + encodeURIComponent(rule._id));
            await loadRules();
        } catch (err) {
            showError($('rules-error'), err, T.saveFailed);
        }
    }

    async function testSaved(rule) {
        try {
            const data = await api('POST', 'rules/' + encodeURIComponent(rule._id) + '/test', {});
            alert(testSummary(data.results));
        } catch (err) {
            alert(err.message);
        }
    }

    function testSummary(results) {
        if (!results.length) return T.testNone;
        return results.map((r) => (r.ok ? '✓ ' : '✗ ') + (T.types[r.type] || r.type) + ': ' + r.detail).join('\n');
    }

    // ---- 编辑器 ----------------------------------------------------------------------

    function actionCard(action, readonly) {
        const type = action.type;
        const fields = (ACTION_FIELDS[type] || []).map(([key, kind]) => {
            const label = ((T.fields[type] || {})[key]) || key;
            let input;
            if (kind === 'priority') {
                input = el('select', { className: 'form-select form-select-sm', 'data-key': key, 'data-kind': kind, disabled: readonly },
                    T.priority.map((text, i) => el('option', { value: i ? String(i) : '', text, selected: String(action.priority || '') === (i ? String(i) : '') })));
            } else {
                const value = kind === 'list' ? asList(action[key]).join(', ') : (action[key] || '');
                input = el('input', {
                    className: 'form-control form-control-sm', 'data-key': key, 'data-kind': kind, value, disabled: readonly,
                    placeholder: kind === 'env' ? 'ENV_VAR_NAME' : (key === 'server' ? 'https://ntfy.sh' : ''),
                });
            }
            return el('div', { className: kind === 'list' || key === 'topic' || key === 'url' ? 'col-12' : 'col-md-6' },
                [el('label', { className: 'form-label small mb-1', text: label }), input]);
        });
        const card = el('div', { className: 'action-card', 'data-type': type }, [
            el('div', { className: 'd-flex justify-content-between align-items-center' + (fields.length ? ' mb-2' : '') }, [
                el('strong', { className: 'small', text: T.types[type] || type }),
                readonly ? null : el('button', { className: 'btn btn-sm btn-link text-danger p-0', type: 'button', text: T.remove,
                    onclick: () => card.remove() }),
            ]),
            fields.length ? el('div', { className: 'row g-2' }, fields) : null,
        ]);
        return card;
    }

    function collectActions() {
        return Array.from($('actions-box').querySelectorAll('.action-card')).map((card) => {
            const action = { type: card.dataset.type };
            card.querySelectorAll('[data-key]').forEach((input) => {
                const key = input.dataset.key;
                const kind = input.dataset.kind;
                if (kind === 'list') {
                    const items = splitList(input.value);
                    if (items.length) action[key] = items;
                } else if (kind === 'priority') {
                    if (input.value) action[key] = Number(input.value);
                } else if (input.value.trim()) {
                    action[key] = input.value.trim();
                }
            });
            return action;
        });
    }

    function collectRule() {
        const match = {};
        [['to', 'f-to'], ['from', 'f-from'], ['subject', 'f-subject'], ['body', 'f-body']].forEach(([key, id]) => {
            const items = splitList($(id).value);
            if (items.length) match[key] = items;
        });
        if ($('f-regex').value.trim()) match.subject_regex = $('f-regex').value.trim();
        if ($('f-attach').value) match.has_attachments = $('f-attach').value === 'true';
        if ($('f-spam').checked) match.include_spam = true;
        const sources = [];
        if ($('f-src-smtp').checked) sources.push('smtp');
        if ($('f-src-imap').checked) sources.push('imap');
        if (!(sources.length === 1 && sources[0] === 'smtp')) match.source = sources;
        const rule = {
            name: $('f-name').value.trim(),
            order: Number($('f-order').value || 100),
            enabled: $('f-enabled').checked,
            stop: $('f-stop').checked,
            match,
            actions: collectActions(),
        };
        if (editing) rule._id = editing;
        return rule;
    }

    function openEditor(rule) {
        const readonly = !!(rule && rule.managed_by === 'env');
        editing = rule ? rule._id : null;
        const match = (rule && rule.match) || {};
        $('rule-modal-title').textContent = rule ? T.editTitle : T.newTitle;
        $('f-name').value = rule ? (rule.name || '') : '';
        $('f-order').value = rule && rule.order !== undefined ? rule.order : 100;
        $('f-enabled').checked = !rule || rule.enabled !== false;
        $('f-stop').checked = !!(rule && rule.stop);
        const sources = asList(match.source);
        $('f-src-smtp').checked = !sources.length || sources.includes('smtp');
        $('f-src-imap').checked = sources.includes('imap');
        $('f-to').value = asList(match.to).join('\n');
        $('f-from').value = asList(match.from).join('\n');
        $('f-subject').value = asList(match.subject).join('\n');
        $('f-body').value = asList(match.body).join('\n');
        $('f-regex').value = match.subject_regex || '';
        $('f-attach').value = match.has_attachments === true ? 'true' : (match.has_attachments === false ? 'false' : '');
        $('f-spam').checked = !!match.include_spam;
        $('actions-box').replaceChildren(...((rule && rule.actions) || [{ type: 'ntfy' }]).map((a) => actionCard(a, readonly)));

        document.querySelectorAll('#ruleModal .modal-body input, #ruleModal .modal-body textarea, #ruleModal .modal-body select')
            .forEach((input) => { if (!input.closest('.action-card')) input.disabled = readonly; });
        $('btn-add-action').disabled = readonly;
        $('add-action-type').disabled = readonly;
        $('btn-save').classList.toggle('d-none', readonly);
        $('editor-readonly').classList.toggle('d-none', !readonly);
        $('editor-error').classList.add('d-none');
        $('editor-result').classList.add('d-none');
        modal.show();
    }

    function showResult(title, rows) {
        $('editor-result-title').textContent = title;
        $('editor-result-body').replaceChildren(...rows);
        $('editor-result').classList.remove('d-none');
    }

    async function dryRun() {
        $('editor-error').classList.add('d-none');
        try {
            const data = await api('POST', 'dry-run', { rule: collectRule(), limit: 100 });
            const rows = data.matched.map((m) => el('div', { className: 'border-bottom py-1' }, [
                el('span', { className: 'text-muted me-2', text: (m.created_at || '').slice(5, 16).replace('T', ' ') }),
                m.source === 'imap' ? el('span', { className: 'chip', text: 'IMAP' }) : null,
                el('span', { className: 'me-2', text: m.from + ' → ' + m.to.join(', ') }),
                el('strong', { text: m.subject }),
            ]));
            showResult(fmt(T.matched, { n: data.matched.length, checked: data.checked }), rows.length ? rows : [el('div', { className: 'text-muted', text: T.noMatch })]);
        } catch (err) {
            showError($('editor-error'), err);
        }
    }

    async function testDraft() {
        $('editor-error').classList.add('d-none');
        try {
            const data = await api('POST', 'test', { rule: collectRule() });
            showResult(T.testTitle, testSummary(data.results).split('\n').map((line) => el('div', { text: line })));
        } catch (err) {
            showError($('editor-error'), err);
        }
    }

    async function save() {
        const rule = collectRule();
        if (!rule.name) {
            showError($('editor-error'), new Error(T.nameRequired));
            return;
        }
        try {
            if (editing) await api('PUT', 'rules/' + encodeURIComponent(editing), rule);
            else await api('POST', 'rules', rule);
            modal.hide();
            await loadRules();
        } catch (err) {
            showError($('editor-error'), err, T.saveFailed);
        }
    }

    // ---- 最近路由记录 ----------------------------------------------------------------

    async function loadStatus() {
        const body = $('status-body');
        try {
            const rows = (await api('GET', 'status?limit=30')).messages || [];
            if (!rows.length) {
                body.replaceChildren(el('tr', {}, [el('td', { className: 'empty', text: T.noStatus })]));
                return;
            }
            body.replaceChildren(...rows.map((r) => el('tr', {}, [
                el('td', { className: 'text-muted small text-nowrap', text: (r.created_at || '').slice(5, 16).replace('T', ' ') }),
                el('td', { className: 'small' }, [
                    r.source === 'imap' ? el('span', { className: 'chip', text: 'IMAP' }) : null,
                    el('span', { text: r.subject || '(no subject)' }),
                    ...r.errors.map((e) => el('div', { className: 'text-danger small', text: e })),
                ]),
                el('td', { className: 'small text-muted', text: r.rules.join(', ') || '-' }),
                el('td', { className: 'small text-nowrap status-' + (r.status || ''), text: T.statuses[r.status] || r.status || '' }),
            ])));
        } catch (err) {
            body.replaceChildren(el('tr', {}, [el('td', { className: 'text-danger small', text: T.loadFailed + err.message })]));
        }
    }

    // ---- 启动 ------------------------------------------------------------------------

    function init() {
        if (LANG === 'en') {
            document.documentElement.lang = 'en';
            document.querySelectorAll('[data-i18n]').forEach((node) => {
                const text = TEXT.en[node.dataset.i18n];
                if (text) node.textContent = text;
            });
        }
        modal = new bootstrap.Modal($('ruleModal'));
        $('add-action-type').replaceChildren(...Object.keys(ACTION_FIELDS).map((type) => el('option', { value: type, text: T.types[type] })));
        $('btn-add-action').addEventListener('click', () => $('actions-box').appendChild(actionCard({ type: $('add-action-type').value }, false)));
        $('btn-new').addEventListener('click', () => openEditor(null));
        $('btn-save').addEventListener('click', save);
        $('btn-dry-run').addEventListener('click', dryRun);
        $('btn-test').addEventListener('click', testDraft);
        $('btn-status').addEventListener('click', loadStatus);
        loadRules();
        loadStatus();
    }

    init();
})();
