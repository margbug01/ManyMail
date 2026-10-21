import { For } from 'solid-js';
import { lang, setLang, t } from '../i18n';
import { state, switchTab } from '../state';

// 分段按钮：选中的是实心主色
export const segClass = (on: boolean) => ['btn', on ? 'btn-primary' : 'btn-outline-secondary'];

export function Navbar(props: { onSettings: () => void; onCompose: () => void }) {
  const info = () => ManyMailI18n.info(lang());
  return (
    <nav class="navbar navbar-light sticky-top">
      <div class="container-fluid gap-2 flex-nowrap">
        <div class="d-flex align-items-center gap-2 flex-shrink-0">
          <button class={['btn btn-sm btn-outline-secondary d-lg-none', { 'd-none': state.tab === 'imap' }]} type="button"
                  id="btn-left-drawer" data-bs-toggle="offcanvas" data-bs-target="#mail-left-column"
                  aria-controls="mail-left-column" title={t('openMailboxPanel')}>
            <i class="bi bi-list"></i>
          </button>
          <a class="navbar-brand d-none d-sm-inline" href="#">
            <i class="bi bi-envelope me-2"></i>ManyMail
          </a>
        </div>

        {/* navbar 只切模式：邮件 / IMAP；文件夹切换放到列表头上 */}
        <div class="btn-group btn-group-sm nav-tabs-group mode-group flex-shrink-1" role="group">
          <button type="button" id="tab-mail" class={segClass(state.tab !== 'imap')} aria-pressed={state.tab !== 'imap' ? 'true' : 'false'} onClick={() => switchTab(state.lastFolder)}>
            <i class="bi bi-envelope me-1"></i><span class="nav-tab-label">{t('mail')}</span>
          </button>
          <button type="button" id="tab-imap" class={segClass(state.tab === 'imap')} aria-pressed={state.tab === 'imap' ? 'true' : 'false'} onClick={() => switchTab('imap')}>
            <i class="bi bi-diagram-3 me-1"></i><span class="nav-tab-label">IMAP</span>
          </button>
        </div>

        <div class="d-flex align-items-center gap-2 flex-shrink-0">
          <button class="btn btn-sm btn-outline-secondary" onClick={() => props.onSettings()} id="btn-settings" title={t('settings')}>
            <i class="bi bi-gear"></i>
          </button>
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-secondary" type="button" id="btn-lang" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Language" title={info().name}>
              <i class="bi bi-translate me-1"></i><span id="lang-label">{info().short}</span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end" id="lang-menu" aria-labelledby="btn-lang">
              <For each={ManyMailI18n.languages}>
                {l => (
                  <li>
                    <button type="button" class={['dropdown-item', { active: l.code === lang() }]} lang={l.locale}
                            aria-current={l.code === lang() ? 'true' : undefined} onClick={() => setLang(l.code)}>
                      {l.name}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
          <button class="btn btn-primary btn-sm" onClick={() => props.onCompose()}>
            <i class="bi bi-pencil-square me-1"></i><span class="d-none d-md-inline">{t('compose')}</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
