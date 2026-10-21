import { onSettled } from 'solid-js';
import type { MessageDetail } from './api';
import { ComposeModal, openCompose, openForward, openReply, openReplyAll } from './components/ComposeModal';
import { ImapPanel, reloadImapFrame } from './components/ImapPanel';
import { MailDetail, type DetailActions } from './components/MailDetail';
import { MailList } from './components/MailList';
import { Navbar } from './components/Navbar';
import { ConfirmModal, Toasts } from './components/Overlays';
import { QueryPanel } from './components/QueryPanel';
import { openSettings, SettingsModal } from './components/SettingsModal';
import { loadDomains, restoreViewState, state, switchTab, type Tab } from './state';

const withOpenMail = (fn: (msg: MessageDetail) => void) => () => {
  if (state.detail.kind === 'mail') fn(state.detail.msg);
};

const detailActions: DetailActions = {
  reply: withOpenMail(openReply),
  replyAll: withOpenMail(openReplyAll),
  forward: withOpenMail(openForward),
};

export function App() {
  onSettled(() => {
    // 恢复邮箱要等域名下拉框填好
    loadDomains().then(restoreViewState);
    // IMAP 子页面请求切到某个 Tab
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'mail-viewer-switch-tab' && event.data.tab) switchTab(event.data.tab as Tab);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
  return (
    <>
      <Navbar onSettings={openSettings} onCompose={openCompose} />
      <Toasts />
      <div class="container-fluid py-4 px-4 mail-shell">
        <div class={['row g-4 mail-layout', { 'mobile-view-detail': state.mobileDetail, 'mobile-view-list': !state.mobileDetail }]} id="mail-layout">
          <QueryPanel />
          <MailList reloadImap={reloadImapFrame} />
          <MailDetail actions={detailActions} />
          <ImapPanel />
        </div>
      </div>
      <ComposeModal />
      <SettingsModal />
      <ConfirmModal />
    </>
  );
}
