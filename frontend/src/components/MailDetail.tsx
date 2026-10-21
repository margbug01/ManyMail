// 第3栏：邮件详情。头部跟着语言重画；正文 iframe 只在换邮件时重建（MailBody）。
import { createEffect, For, Match, Show, Switch, untrack } from 'solid-js';
import type { Address, Attachment, MessageDetail, SentMessage } from '../api';
import { fullDate, formatSize, t, type TextKey } from '../i18n';
import { renderMailBody } from '../mailBody';
import { deleteEmail, mailboxEmail, restoreEmail, showListView, state, togglePlainText, trashAction } from '../state';
import { copyText, showConfirm, toastError } from '../ui';

export interface DetailActions { reply: () => void; replyAll: () => void; forward: () => void }

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 没有 HTML 正文时把纯文本转义后放进 iframe；空正文给一句灰字（文案取打开时的语言，切语言不重建 iframe）
const bodyContent = (msg: { html?: string; text?: string }) =>
  msg.html || escapeHtml(msg.text || '').replace(/\n/g, '<br>') || `<i style="color:#6c757d;">${untrack(() => t('emptyContent'))}</i>`;

export const addressText = (entry: Address | string | undefined) =>
  !entry ? '' : typeof entry === 'string' ? entry : entry.address || entry.name || '';

export function MailDetail(props: { actions: DetailActions }) {
  return (
    <div class="col-12 col-lg-5 mail-col" id="mail-detail-column" style={{ display: state.tab === 'imap' ? 'none' : undefined }}>
      <div class="card h-100" id="mail-detail-card">
        <div class="card-header d-flex align-items-center gap-2">
          <button type="button" class="btn btn-sm btn-outline-secondary mail-detail-back" onClick={showListView}>
            <i class="bi bi-chevron-left"></i><span>{t('backToList')}</span>
          </button>
          <span class="text-truncate">
            <i class="bi bi-file-text me-2"></i><span>{t('mailDetail')}</span>
          </span>
        </div>
        <div class="card-body">
          <div id="mail-detail-content">
            <Switch fallback={
              <div class="text-center text-muted py-5">
                <i class="bi bi-envelope-paper" style="font-size:3rem;opacity:0.3;"></i>
                <p class="mt-3">{t('selectMailHint')}</p>
              </div>
            }>
              <Match when={state.detail.kind === 'loading' && state.detail.sent}>
                <div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> {t('loading')}</div>
              </Match>
              <Match when={state.detail.kind === 'loading'}><DetailSkeleton /></Match>
              <Match when={state.detail.kind === 'error' && state.detail}>
                {d => d().alert
                  ? <div class="alert alert-danger">{d().message}</div>
                  : <div class="error-state"><i class="bi bi-exclamation-triangle d-block"></i><p>{d().message}</p></div>}
              </Match>
              <Match when={state.detail.kind === 'mail' && state.detail} keyed>
                {d => <MailView id={d.id} trash={d.trash} msg={d.msg} actions={props.actions} />}
              </Match>
              <Match when={state.detail.kind === 'sent' && state.detail} keyed>
                {d => <SentView msg={d.msg} />}
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </div>
  );
}

const DetailSkeleton = () => (
  <>
    <div class="mb-3"><div class="skeleton skeleton-text" style="width:50%"></div></div>
    <div class="mb-3"><div class="skeleton skeleton-text" style="width:70%"></div></div>
    <div class="mb-3"><div class="skeleton skeleton-text" style="width:40%"></div></div>
    <hr />
    <div style="background:#f8f9fa; padding:15px; border-radius:8px;">
      <div class="skeleton skeleton-text mb-2" style="width:90%"></div>
      <div class="skeleton skeleton-text mb-2" style="width:85%"></div>
      <div class="skeleton skeleton-text" style="width:60%"></div>
    </div>
  </>
);

// The body iframe lives inside `host`; Solid renders host empty and never patches it.
function MailBody(props: { frameId: string; content: string; style: string; id?: string }) {
  let host!: HTMLDivElement;
  createEffect(() => props.content, content => renderMailBody(host, props.frameId, content));
  return <div class="mail-body-container" id={props.id} style={props.style} ref={host} />;
}

function MetaRow(props: { label: string; children: unknown; show: boolean }) {
  return (
    <Show when={props.show}>
      <div class="detail-meta-row"><span class="detail-meta-label">{props.label}:</span><span class="detail-meta-value">{props.children as never}</span></div>
    </Show>
  );
}

function AddressList(props: { list?: (Address | string)[] }) {
  const entries = () => (Array.isArray(props.list) ? props.list : []).map(addressText).filter(Boolean);
  const self = () => mailboxEmail().toLowerCase();
  return (
    <For each={entries()}>
      {(addr, i) => (
        <>
          {i() > 0 ? ', ' : ''}
          {/* 泛解析邮箱下，标出这封信究竟是发给哪个别名的 */}
          <span class={{ 'detail-self-address': Boolean(self()) && addr.toLowerCase() === self() }}>{addr}</span>
        </>
      )}
    </For>
  );
}

const hasAddresses = (list?: (Address | string)[]) => (Array.isArray(list) ? list : []).some(e => addressText(e));

function ActionButton(props: { cls: string; icon: string; label: TextKey; onClick: () => void; id?: string }) {
  return (
    <button class={`btn btn-sm ${props.cls}`} id={props.id} onClick={() => props.onClick()} title={t(props.label)} aria-label={t(props.label)}>
      <i class={`bi ${props.icon}`}></i><span class="btn-label">{t(props.label)}</span>
    </button>
  );
}

async function downloadEml(id: string, subject?: string) {
  const filename = `${(subject || id).slice(0, 60).replace(/[\\/:*?"<>|]/g, '_')}.eml`;
  const url = `/api/inbox/source/${encodeURIComponent(id)}?email=${encodeURIComponent(mailboxEmail())}&filename=${encodeURIComponent(filename)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      toastError(resp.status === 404 ? t('emlUnavailable') : t('loadFailed'));
      return;
    }
    const objectUrl = URL.createObjectURL(await resp.blob());
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (e) {
    toastError(t('networkError') + ': ' + (e instanceof Error ? e.message : String(e)));
  }
}

const attachmentId = (att: Attachment, index: number) => encodeURIComponent(String(att.id || (att.index ?? index)));

function Attachments(props: { id: string; list?: Attachment[] }) {
  return (
    <Show when={props.list && props.list.length > 0}>
      <div class="mb-3">
        <strong><i class="bi bi-paperclip me-1"></i>{t('attachments')}:</strong>
        <div class="mt-2 d-flex flex-wrap gap-2">
          <For each={props.list}>
            {(att, index) => {
              const filename = () => att.filename || `attachment_${index()}`;
              const href = () => `/api/inbox/attachment/${encodeURIComponent(props.id)}/${attachmentId(att, index())}?email=${encodeURIComponent(mailboxEmail())}&filename=${encodeURIComponent(filename())}`;
              return (
                <a class="btn btn-sm btn-outline-secondary" href={href()} download title={t('download')}>
                  <i class="bi bi-download me-1"></i>{filename()}
                  <Show when={formatSize(att.size)}>{size => <> <span class="text-muted">({size()})</span></>}</Show>
                </a>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}

function MailView(props: { id: string; trash: boolean; msg: MessageDetail; actions: DetailActions }) {
  const msg = () => props.msg;
  const permanentDelete = () => showConfirm({
    title: t('permanentDelete'),
    message: t('confirmPermanentDelete'),
    okLabel: t('permanentDeleteOk'),
    onConfirm: () => trashAction('/api/inbox/permanent-delete', props.id, t('permanentDelete')),
  });
  return (
    <>
      <div id="mail-detail-head">
        <div class="detail-actions mb-3">
          <Show when={props.trash} fallback={
            <>
              <ActionButton cls="btn-outline-primary" icon="bi-reply" label="reply" onClick={props.actions.reply} />
              <ActionButton cls="btn-outline-primary" icon="bi-reply-all" label="replyAll" onClick={props.actions.replyAll} />
              <ActionButton cls="btn-outline-secondary" icon="bi-arrow-right-short" label="forward" onClick={props.actions.forward} />
              <ActionButton cls="btn-outline-secondary" id="btn-toggle-plain" icon={state.plainText ? 'bi-code-slash' : 'bi-file-text'}
                            label={state.plainText ? 'viewHtml' : 'viewPlain'} onClick={togglePlainText} />
              <ActionButton cls="btn-outline-secondary" icon="bi-download" label="downloadEml" onClick={() => downloadEml(props.id, msg().subject)} />
              <ActionButton cls="btn-outline-danger" icon="bi-trash" label="delete" onClick={() => deleteEmail(props.id)} />
            </>
          }>
            <ActionButton cls="btn-outline-primary" icon="bi-arrow-counterclockwise" label="restore" onClick={() => restoreEmail(props.id)} />
            <ActionButton cls="btn-outline-danger" icon="bi-x-circle" label="permanentDelete" onClick={permanentDelete} />
          </Show>
        </div>
        <MetaRow label={t('from')} show={Boolean(msg().from?.name || msg().from?.address)}>
          {msg().from?.name ? `${msg().from?.name} <${msg().from?.address || ''}>` : msg().from?.address}
        </MetaRow>
        <MetaRow label={t('to')} show={hasAddresses(msg().to)}><AddressList list={msg().to} /></MetaRow>
        <MetaRow label={t('cc')} show={hasAddresses(msg().cc)}><AddressList list={msg().cc} /></MetaRow>
        <MetaRow label={t('subject')} show>{msg().subject || t('noSubject')}</MetaRow>
        <MetaRow label={t('time')} show={Boolean(fullDate(msg().createdAt))}>{fullDate(msg().createdAt)}</MetaRow>
        <MetaRow label={t('verifyCode')} show={Boolean(msg().extracted_code)}>
          <button type="button" class="badge bg-success code-badge" title={t('copyCode')} onClick={e => copyText(msg().extracted_code || '', e)}>
            <i class="bi bi-clipboard me-1"></i>{msg().extracted_code}
          </button>
        </MetaRow>
        <Attachments id={props.id} list={msg().attachments} />
      </div>
      <hr />
      <MailBody id="mail-body-html" frameId="mail-body-frame" content={bodyContent(msg())}
                style={`background:#fff; padding:0; overflow:hidden; display:${state.plainText ? 'none' : 'block'};`} />
      <pre id="mail-body-plain" class="mail-plaintext" style={`display:${state.plainText ? 'block' : 'none'};background:#f8f9fa;border-radius:8px;`}>
        {msg().text || t('emptyContent')}
      </pre>
    </>
  );
}

function SentView(props: { msg: SentMessage }) {
  return (
    <>
      <div id="mail-detail-head">
        <div class="mb-3"><strong>{t('from')}:</strong> {props.msg.from_address || mailboxEmail()}</div>
        <div class="mb-3"><strong>{t('to')}:</strong> {(props.msg.to || []).join(', ')}</div>
        <div class="mb-3"><strong>{t('subject')}:</strong> {props.msg.subject || t('noSubject')}</div>
        <div class="mb-3"><strong>{t('time')}:</strong> {fullDate(props.msg.createdAt)}</div>
      </div>
      <hr />
      <MailBody frameId="sent-body-frame" content={bodyContent(props.msg)} style="background:#f8f9fa; padding:0; border-radius:8px; overflow:hidden;" />
    </>
  );
}
