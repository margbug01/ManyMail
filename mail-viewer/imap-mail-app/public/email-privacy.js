(function () {
  'use strict';
  const rasterImage = /^data:image\/(png|gif|jpeg|webp);base64,/i;
  const allowedTags = new Set('a abbr b blockquote br code div em font h1 h2 h3 h4 h5 h6 hr i img li ol p pre span strong style table tbody td th thead tr u ul'.split(' '));
  const proxyPath = '/api/image-proxy';

  function remoteUrl(value) {
    try {
      const normalized = value.startsWith('//') ? 'https:' + value : value;
      const url = new URL(normalized);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  }

  // 链接里用来认人/记来源的参数。去掉不影响打开页面，但营销平台就对不上是谁点的了
  const trackingParam = /^(utm_\w+|fbclid|gclid|gclsrc|gbraid|wbraid|dclid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|oly_anon_id|oly_enc_id|vero_id|vero_conv|ck_subscriber_id|_kx|sc_cid|s_cid|trk|trkcampaign|spm|ref_src)$/i;

  // 常见的「跳转包装」：真实地址在参数里，拆出来直接去，不经过中转站
  function unwrapRedirect(url) {
    const host = url.hostname.toLowerCase();
    let inner = null;
    if (/(^|\.)google\.[a-z.]+$/.test(host) && url.pathname === '/url') inner = url.searchParams.get('q') || url.searchParams.get('url');
    else if (host.endsWith('.safelinks.protection.outlook.com')) inner = url.searchParams.get('url');
    else if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && url.pathname === '/l.php') inner = url.searchParams.get('u');
    else if (host === 'l.instagram.com') inner = url.searchParams.get('u');
    else if (host === 'www.linkedin.com' && url.pathname === '/redir/redirect') inner = url.searchParams.get('url');
    if (!inner) return url;
    try {
      const target = new URL(inner);
      return ['http:', 'https:'].includes(target.protocol) ? target : url;
    } catch {
      return url;
    }
  }

  function cleanLink(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return href;
    }
    for (let depth = 0; depth < 3; depth++) {
      const next = unwrapRedirect(url);
      if (next === url) break;
      url = next;
    }
    Array.from(url.searchParams.keys()).forEach(key => {
      if (trackingParam.test(key)) url.searchParams.delete(key);
    });
    return url.href;
  }

  function prepare(html, allowImages) {
    const template = document.createElement('template');
    template.innerHTML = html || '';
    template.content.querySelectorAll('*').forEach(element => {
      if (!allowedTags.has(element.localName)) {
        element.remove();
        return;
      }
      Array.from(element.attributes).forEach(attribute => {
        if (/^on/i.test(attribute.name) || ['srcset', 'background', 'ping', 'action', 'formaction', 'xlink:href'].includes(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      });
      if (element.localName === 'a') {
        const href = element.getAttribute('href') || '';
        const remote = remoteUrl(href);
        if (remote) {
          const cleaned = cleanLink(remote);
          element.setAttribute('href', cleaned);
          // 悬停显示真正要去的地址：显示文字可以随便写，营销邮件的点击跳转站也藏在这里
          element.setAttribute('title', cleaned);
        } else if (!/^mailto:[^\s]+$/i.test(href) && !href.startsWith('#')) element.removeAttribute('href');
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
        element.setAttribute('referrerpolicy', 'no-referrer');
      }
      if (element.localName === 'img') {
        const source = element.getAttribute('src') || '';
        const remote = remoteUrl(element.getAttribute('data-remote-src') || source);
        element.removeAttribute('src');
        element.removeAttribute('data-remote-src');
        element.setAttribute('referrerpolicy', 'no-referrer');
        if (rasterImage.test(source)) element.setAttribute('src', source);
        else if (remote) {
          element.setAttribute('data-remote-src', remote);
          if (allowImages) element.setAttribute('src', proxyPath + '?url=' + encodeURIComponent(remote));
          else if (!element.getAttribute('alt')) element.setAttribute('alt', '[External image blocked]');
        }
      }
    });
    return template.innerHTML;
  }

  function head(allowImages) {
    const imageSources = 'data:' + (allowImages ? ' ' + location.origin + proxyPath : '');
    const policy = "default-src 'none'; img-src " + imageSources + "; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    return '<meta http-equiv="Content-Security-Policy" content="' + policy + '"><meta name="referrer" content="no-referrer">';
  }

  function control(iframe, html, allowImages, render) {
    if (iframe.previousElementSibling && iframe.previousElementSibling.dataset.emailPrivacy === 'control') iframe.previousElementSibling.remove();
    const template = document.createElement('template');
    template.innerHTML = prepare(html, false);
    if (!template.content.querySelector('img[data-remote-src]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.emailPrivacy = 'control';
    const chinese = (document.documentElement.lang || navigator.language).toLowerCase().startsWith('zh');
    button.textContent = chinese
      ? (allowImages ? '本封邮件已允许外部图片 · 点击重新屏蔽' : '外部图片已屏蔽 · 加载本封邮件的图片')
      : (allowImages ? 'External images allowed · Block again' : 'External images blocked · Load for this message');
    button.style.cssText = 'display:block;margin:8px 0;padding:6px 10px;font:inherit;cursor:pointer;';
    button.addEventListener('click', () => {
      const warning = chinese ? '加载图片可能让发件人知道你已阅读邮件。即使通过代理也无法消除这种追踪。仅为本封邮件加载？' : 'Loading images may tell the sender you opened this email, even through a proxy. Load images for this message only?';
      if (allowImages || window.confirm(warning)) render(!allowImages);
    });
    iframe.before(button);
  }

  function freshFrame(iframe) {
    if (iframe.dataset.emailRendered) {
      const replacement = iframe.cloneNode(false);
      replacement.removeAttribute('src');
      replacement.removeAttribute('srcdoc');
      iframe.replaceWith(replacement);
      iframe = replacement;
    }
    iframe.dataset.emailRendered = 'true';
    return iframe;
  }

  window.EmailPrivacy = Object.freeze({ prepare, head, control, freshFrame });
}());
