// IMAP 子应用的 iframe（子应用本身不在这里重写）。src 和窄屏高度都由这里命令式设置，Solid 不绑定它们。
import { createEffect, onSettled } from 'solid-js';
import { state } from '../state';

const IMAP_URL = '/imap/?embedded=1';
let frame: HTMLIFrameElement | undefined;

// 窄屏下 iframe 撑到可视区域底部（手机地址栏收起时 visualViewport 会变）
export function fitMobileImapFrame() {
  if (!frame || !frame.getClientRects().length) return;
  if (window.matchMedia('(max-width: 991.98px)').matches) {
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
    frame.style.height = Math.max(180, bottom - frame.getBoundingClientRect().top - 8) + 'px';
    frame.style.minHeight = '0';
  } else {
    frame.style.removeProperty('height');
    frame.style.removeProperty('min-height');
  }
}

export function reloadImapFrame() {
  if (frame) frame.src = IMAP_URL;
}

export function ImapPanel() {
  // 第一次切到 IMAP 才加载
  createEffect(() => state.tab === 'imap', isImap => {
    if (!isImap || !frame) return;
    if (!frame.getAttribute('src')) frame.src = IMAP_URL;
    requestAnimationFrame(fitMobileImapFrame);
  });
  onSettled(() => {
    window.addEventListener('resize', fitMobileImapFrame);
    window.visualViewport?.addEventListener('resize', fitMobileImapFrame);
    return () => {
      window.removeEventListener('resize', fitMobileImapFrame);
      window.visualViewport?.removeEventListener('resize', fitMobileImapFrame);
    };
  });
  return (
    <div class="col-12" id="imap-panel" style={{ display: state.tab === 'imap' ? 'block' : 'none' }}>
      <div class="card">
        <div class="card-body">
          <iframe id="imap-frame" title="IMAP Mail Client" loading="lazy" referrerpolicy="no-referrer" ref={el => { frame = el; }}></iframe>
        </div>
      </div>
    </div>
  );
}
