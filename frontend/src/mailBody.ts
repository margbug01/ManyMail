// Renders a mail body into a sandboxed iframe inside `host`. Solid renders `host` empty and
// never touches its children: EmailPrivacy swaps the iframe and inserts its image button
// there. tools/test-email-privacy.cjs checks this renderer for request leaks.

const SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

// 定宽邮件比详情栏宽时的缩放比例。留 12px 余量给 body 右侧内边距，
// 并设下限，避免超宽邮件被缩到看不清。
export function computeBodyScale(available: number, natural: number): number {
  if (!available || !natural || natural <= available + 1) return 1;
  return Math.max(available / (natural + 12), 0.4);
}

// Returns a cleanup that stops the resize observer.
export function renderMailBody(host: HTMLElement, frameId: string, mailContent: string): () => void {
  host.replaceChildren();
  const iframe = document.createElement('iframe');
  iframe.id = frameId;
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = 'width:100%;border:none;min-height:200px;';
  host.append(iframe);

  let observer: ResizeObserver | null = null;
  const render = (frame: HTMLIFrameElement, allowImages: boolean) => {
    frame = EmailPrivacy.freshFrame(frame);
    EmailPrivacy.control(frame, mailContent, allowImages, allowed => render(frame, allowed));
    observer?.disconnect();
    observer = writeFrame(frame, EmailPrivacy.prepare(mailContent, allowImages), allowImages);
  };
  render(iframe, false);
  return () => observer?.disconnect();
}

function writeFrame(iframe: HTMLIFrameElement, protectedContent: string, allowImages: boolean): ResizeObserver | null {
  const iframeDoc = (iframe.contentDocument || iframe.contentWindow?.document) as Document;
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
      // 定宽邮件（常见 600px 表格）比详情栏宽时整体缩放，否则右边会被 overflow:hidden 直接裁掉
      const scale = computeBodyScale(available, natural);
      if (scale < 1) {
        body.style.width = natural + 'px';
        // 从左上角缩，默认的中心缩放会把内容往右下挪、底部被切掉
        body.style.transformOrigin = '0 0';
        body.style.transform = `scale(${scale})`;
      }
      // 只量 body：<html> 的高度至少等于 iframe 本身，量它会让高度只增不减，
      // 每次重新适配（图片加载、窗口变宽、手机地址栏收起）底下就多一截空白
      const height = Math.max(body.scrollHeight, body.offsetHeight);
      iframe.style.height = Math.ceil(height * scale) + 'px';
    } catch {}
  };

  // 图片加载完成后重新适配
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
  if (!window.ResizeObserver || !iframe.parentElement) return null;
  let lastWidth = iframe.clientWidth;
  const observer = new ResizeObserver(() => {
    const width = iframe.clientWidth;
    if (Math.abs(width - lastWidth) < 1) return;
    lastWidth = width;
    fitBody();
  });
  observer.observe(iframe.parentElement);
  return observer;
}
