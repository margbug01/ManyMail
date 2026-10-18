#!/usr/bin/env node
// 把 i18n/*.json（中英以外的界面语言）打包成 i18n.js，写两份：imap-bridge/public（桥接自己用）
// 和 web/shared（编进 Go 程序），内容相同。
// 主界面、IMAP 子页面、规则页、登录页都加载这一个文件；中文和英文词典仍写在各自的脚本里。
//   node tools/build-i18n.cjs          重新生成
//   node tools/build-i18n.cjs --check  只比对，生成结果和仓库里的不一致就退出 1
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'i18n');
const OUTS = [path.join(ROOT, 'imap-bridge', 'public', 'i18n.js'), path.join(ROOT, 'web', 'shared', 'i18n.js')];

// 顺序就是菜单里的顺序；fallback = 词典缺键时退回哪种语言
const LANGUAGES = [
    { code: 'zh', name: '简体中文', short: '中', locale: 'zh-CN' },
    { code: 'en', name: 'English', short: 'EN', locale: 'en-US' },
    { code: 'zh-TW', name: '繁體中文', short: '繁', locale: 'zh-TW', fallback: 'zh' },
    { code: 'ja', name: '日本語', short: '日', locale: 'ja-JP', fallback: 'en' },
    { code: 'ko', name: '한국어', short: '한', locale: 'ko-KR', fallback: 'en' },
    { code: 'es', name: 'Español', short: 'ES', locale: 'es-ES', fallback: 'en' },
    { code: 'fr', name: 'Français', short: 'FR', locale: 'fr-FR', fallback: 'en' },
    { code: 'de', name: 'Deutsch', short: 'DE', locale: 'de-DE', fallback: 'en' },
    { code: 'ru', name: 'Русский', short: 'RU', locale: 'ru-RU', fallback: 'en' },
];

function build() {
    const dicts = {};
    for (const lang of LANGUAGES) {
        if (lang.code === 'zh' || lang.code === 'en') continue;
        const file = path.join(SRC_DIR, lang.code + '.json');
        dicts[lang.code] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return `// 由 tools/build-i18n.cjs 从 i18n/*.json 生成，别手改。
(function (root) {
    'use strict';
    var STORAGE_KEY = 'manymail-lang';
    var LANGUAGES = ${JSON.stringify(LANGUAGES)};
    var DICTS = ${JSON.stringify(dicts)};

    function find(code) {
        for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === code) return LANGUAGES[i];
        return null;
    }

    // 'zh-Hant-TW' / 'zh-HK' -> zh-TW，'ja-JP' -> ja；不认识的返回 null
    function normalize(code) {
        if (!code) return null;
        var c = String(code);
        if (find(c)) return c;
        var lower = c.toLowerCase();
        if (/^zh[-_](tw|hk|mo|hant)/.test(lower)) return 'zh-TW';
        var base = lower.split(/[-_]/)[0];
        return find(base) ? base : null;
    }

    // 先看用户选过的，再看浏览器语言，都不认识就用英文
    function detect() {
        var saved = null;
        try { saved = root.localStorage.getItem(STORAGE_KEY); } catch (e) { /* 隐私模式 */ }
        var n = normalize(saved);
        if (n) return n;
        var nav = root.navigator || {};
        var list = nav.languages && nav.languages.length ? nav.languages : [nav.language];
        for (var i = 0; i < list.length; i++) {
            n = normalize(list[i]);
            if (n) return n;
        }
        return 'en';
    }

    function save(code) {
        try { root.localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* 隐私模式 */ }
    }

    function info(code) { return find(code) || find('en'); }

    // 某个页面的词典：base = { zh: {...}, en: {...} }，其余语言按 fallback 补齐缺的键
    function dict(code, section, base) {
        if (base[code]) return base[code];
        var lang = info(code);
        var extra = (DICTS[lang.code] || {})[section] || {};
        return Object.assign({}, base[lang.fallback] || base.en, extra);
    }

    root.ManyMailI18n = {
        languages: LANGUAGES,
        normalize: normalize,
        detect: detect,
        save: save,
        info: info,
        locale: function (code) { return info(code).locale; },
        dict: dict,
        section: function (code, section) { return (DICTS[code] || {})[section] || null; },
    };
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

const out = build();
if (process.argv.includes('--check')) {
    // Windows 上 autocrlf 签出来是 CRLF，换行不算差异
    for (const OUT of OUTS) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
        if (cur !== out) {
            console.error(path.relative(ROOT, OUT) + ' is stale: run node tools/build-i18n.cjs');
            process.exit(1);
        }
    }
    console.log('i18n.js up to date');
} else {
    for (const OUT of OUTS) {
        fs.writeFileSync(OUT, out);
        console.log('wrote ' + path.relative(ROOT, OUT));
    }
}
