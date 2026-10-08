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
        if (!remoteUrl(href) && !/^mailto:[^\s]+$/i.test(href) && !href.startsWith('#')) element.removeAttribute('href');
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
