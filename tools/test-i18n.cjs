#!/usr/bin/env node
// 界面多语言门禁：
// 1. i18n/<lang>.json 必须覆盖各页面英文词典的全部键，占位符一致，不能有多余的旧键；
// 2. folders 段覆盖 IMAP 页的全部中文文件夹名；
// 3. imap-bridge/public/i18n.js、web/shared/i18n.js 和 JSON 同步（否则跑 node tools/build-i18n.cjs）；
// 4. 语言识别：浏览器语言、已保存的选择、未知语言的回退。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const errors = [];

// 从源码里取出对象字面量（词典里只有字符串、数组和嵌套对象）
function grab(rel, startRe, endMarker) {
    const s = read(rel);
    const i = s.search(startRe);
    const j = s.indexOf(endMarker, i);
    if (i < 0 || j < 0) throw new Error('dictionary not found in ' + rel);
    return vm.runInNewContext('(' + s.slice(s.indexOf('{', i), j + endMarker.length - 1) + ')');
}

const sources = {
    app: grab('web/static/js/app.js', /const LANGS = \{/, '\n};'),
    imap: grab('imap-bridge/public/app.js', /const LANGS = \{/, '\n};'),
    rules: grab('web/static/js/rules.js', /const TEXT = \{/, '\n    };'),
    login: grab('web/templates/login.html', /const LANGS = \{/, '\n        };'),
    privacy: grab('imap-bridge/public/email-privacy.js', /const TEXT = \{/, '\n  };'),
};
const folderNames = new Set(Object.values(grab('imap-bridge/public/app.js', /var FOLDER_ZH = \{/, '\n};')));

const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');

function compare(en, tr, where) {
    if (Array.isArray(en)) {
        if (!Array.isArray(tr) || tr.length !== en.length) errors.push(where + ': expected array of ' + en.length);
        else en.forEach((v, i) => compare(v, tr[i], where + '[' + i + ']'));
        return;
    }
    if (en && typeof en === 'object') {
        if (!tr || typeof tr !== 'object') { errors.push(where + ': missing'); return; }
        for (const k of Object.keys(en)) {
            if (!(k in tr)) errors.push(where + '.' + k + ': missing');
            else compare(en[k], tr[k], where + '.' + k);
        }
        for (const k of Object.keys(tr)) if (!(k in en)) errors.push(where + '.' + k + ': not in English source (stale?)');
        return;
    }
    if (typeof tr !== 'string' || !tr.trim()) { errors.push(where + ': empty'); return; }
    if (placeholders(en) !== placeholders(tr)) errors.push(where + ': placeholders ' + placeholders(en) + ' vs ' + placeholders(tr));
}

const i18nDir = path.join(ROOT, 'i18n');
const files = fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json'));
if (!files.length) errors.push('no translations in i18n/');
for (const file of files) {
    const code = file.replace(/\.json$/, '');
    const data = JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8'));
    for (const section of Object.keys(sources)) {
        // 规则页的英文词典只覆盖部分键，其余沿用中文，所以要和中文合并后再比
        const en = section === 'rules' ? Object.assign({}, sources.rules.zh, sources.rules.en) : sources[section].en;
        compare(en, data[section], code + '.' + section);
    }
    const folders = data.folders || {};
    for (const name of folderNames) if (!folders[name]) errors.push(code + '.folders: missing ' + name);
    for (const k of Object.keys(data)) if (!(k in sources) && k !== 'folders') errors.push(code + ': unknown section ' + k);
}

try {
    execFileSync(process.execPath, [path.join(__dirname, 'build-i18n.cjs'), '--check'], { stdio: 'pipe' });
} catch (e) {
    errors.push(String(e.stderr || e.message).trim());
}

// 语言识别
function load(saved, navLangs) {
    const store = saved ? { 'manymail-lang': saved } : {};
    const win = {
        localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        navigator: { languages: navLangs, language: navLangs[0] },
    };
    vm.runInNewContext(read('imap-bridge/public/i18n.js'), { window: win });
    return win.ManyMailI18n;
}
// The Go binary embeds copies of the bridge's shared scripts; they must not drift apart.
for (const f of ['i18n.js', 'email-privacy.js']) {
    if (read('imap-bridge/public/' + f).replace(/\r\n/g, '\n') !== read('web/shared/' + f).replace(/\r\n/g, '\n')) {
        errors.push(`web/shared/${f} differs from imap-bridge/public/${f}`);
    }
}
const cases = [
    [null, ['zh-CN'], 'zh'],
    [null, ['zh-Hant-TW'], 'zh-TW'],
    [null, ['zh-HK', 'en'], 'zh-TW'],
    [null, ['ja-JP'], 'ja'],
    [null, ['pt-BR', 'de-AT'], 'de'],
    [null, ['pt-BR'], 'en'],
    ['en', ['zh-CN'], 'en'],
    ['ko', ['en-US'], 'ko'],
    ['xx', ['fr-CA'], 'fr'],
];
for (const [saved, nav, want] of cases) {
    const got = load(saved, nav).detect();
    if (got !== want) errors.push(`detect(saved=${saved}, nav=${nav}) = ${got}, want ${want}`);
}
const lib = load(null, ['en']);
const base = { zh: { a: '甲', b: '乙' }, en: { a: 'A', b: 'B' } };
if (lib.dict('zh', 'app', base) !== base.zh) errors.push('dict(zh) should return the inline dictionary');
for (const lang of lib.languages) {
    if (lang.code === 'zh' || lang.code === 'en') continue;
    // 'none' 段不存在，所有键都应该来自 fallback 语言
    const got = lib.dict(lang.code, 'none', base).b;
    const want = lang.fallback === 'zh' ? '乙' : 'B';
    if (got !== want) errors.push(`dict(${lang.code}) fallback = ${got}, want ${want}`);
}

if (errors.length) {
    console.error(errors.slice(0, 50).join('\n'));
    if (errors.length > 50) console.error('... ' + (errors.length - 50) + ' more');
    process.exit(1);
}
console.log(`i18n OK: ${files.length} languages, ${Object.keys(sources).length} pages, ${cases.length} detection cases`);
