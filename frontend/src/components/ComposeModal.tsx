// 撰写/回复/转发。static backdrop：点遮罩和 Esc 都不会直接关掉草稿。
// Quill owns the editor div's children; Solid renders that div empty.
import { createStore, flush, For, Show } from 'solid-js';
import { errorText, postJSON, type MessageDetail, type Reply } from '../api';
import { formatSize, locale, t, type TextKey } from '../i18n';
import { mailboxEmail, state } from '../state';
import { selectValue } from '../dom';
import { showConfirm, showToast, toastError } from '../ui';
import { addressText } from './MailDetail';

const DRAFT_KEY = 'manymail-draft';
const MAX_ATTACHMENT_MB = 5;
const MAX_ATTACHMENT_TOTAL_MB = 10;
export const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

interface PickedFile { filename: string; size: number; contentType: string; content: string }

interface Draft { fromPrefix?: string; fromDomain?: string; recipients?: string[]; subject?: string; html?: string; title?: string }

const blank = () => ({
  titleIcon: 'bi-pencil-square',
  titleKey: 'composeEmail' as TextKey,
  fromPrefix: '',
  fromDomain: '',
  recipients: [] as string[],
  toInput: '',
  subject: '',
  attachments: [] as PickedFile[],
  alert: null as { kind: 'success' | 'danger'; text: string } | null,
  send: 'idle' as 'idle' | 'sending' | 'sent',
  draftBar: false,
  focused: false,
});

const [c, setC] = createStore(blank());

let modalEl: HTMLElement | undefined;
let editorEl: HTMLDivElement | undefined;
let editor: QuillEditor | null = null;
let visible = false;
let openSeq = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;

function getEditor(): QuillEditor {
  if (!editor) {
    editor = new Quill(editorEl!, {
      theme: 'snow',
      placeholder: t('editorPlaceholder'),
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ color: [] }, { background: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['blockquote', 'code-block'],
          ['link', 'image'],
          ['clean'],
        ],
      },
    });
    editor.on('text-change', saveDraft);
  }
  return editor;
}

// ---- 草稿（附件不入草稿，base64 太大会撑爆 localStorage） ----
const isDirty = () => Boolean(c.recipients.length || c.subject.trim() || getEditor().getText().trim() || c.attachments.length);

function saveDraft() {
  if (!visible) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!isDirty()) { discardDraft(); return; }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        fromPrefix: c.fromPrefix,
        fromDomain: c.fromDomain,
        recipients: [...c.recipients],
        subject: c.subject,
        html: getEditor().root.innerHTML,
        title: t(c.titleKey),
      }));
    } catch {}
  }, 400);
}

function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function discardDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  setC(s => { s.draftBar = false; });
}

function restoreDraft() {
  const draft = loadDraft();
  if (!draft) return;
  setC(s => {
    s.fromPrefix = draft.fromPrefix || '';
    if (state.domains.includes(draft.fromDomain || '')) s.fromDomain = draft.fromDomain!;
    s.recipients = uniqueAddresses(draft.recipients || []);
    s.subject = draft.subject || '';
    s.draftBar = false;
  });
  if (draft.html) getEditor().clipboard.dangerouslyPasteHTML(draft.html);
}

// ---- 收件人 chip ----
function uniqueAddresses(list: string[], start: string[] = []): string[] {
  const out = [...start];
  for (const addr of list.filter(Boolean)) if (!out.some(x => x.toLowerCase() === addr.toLowerCase())) out.push(addr);
  return out;
}

function addRecipients(raw: string) {
  const parts = String(raw || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  const next = uniqueAddresses(parts, c.recipients);
  if (next.length === c.recipients.length) return;
  setC(s => { s.recipients = next; });
  saveDraft();
}

function removeRecipient(index: number) {
  setC(s => { s.recipients = s.recipients.filter((_, i) => i !== index); });
  saveDraft();
}

// ---- 附件 ----
const totalBytes = () => c.attachments.reduce((sum, a) => sum + a.size, 0);

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function onAttachmentsPicked(input: HTMLInputElement) {
  const files = Array.from(input.files || []);
  input.value = '';
  const seq = openSeq;
  for (const file of files) {
    if (seq !== openSeq || !visible) return;
    flush();
    if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
      toastError(t('attachmentTooLarge', { name: file.name, max: MAX_ATTACHMENT_MB }));
      continue;
    }
    if (totalBytes() + file.size > MAX_ATTACHMENT_TOTAL_MB * 1024 * 1024) {
      toastError(t('attachmentTotalTooLarge', { max: MAX_ATTACHMENT_TOTAL_MB }));
      break;
    }
    try {
      const content = await readFileAsBase64(file);
      if (seq !== openSeq || !visible) return;
      flush();
      if (totalBytes() + file.size > MAX_ATTACHMENT_TOTAL_MB * 1024 * 1024) {
        toastError(t('attachmentTotalTooLarge', { max: MAX_ATTACHMENT_TOTAL_MB }));
        continue;
      }
      setC(s => { s.attachments.push({ filename: file.name, size: file.size, contentType: file.type || '', content }); });
      flush();
    } catch {
      if (seq !== openSeq || !visible) return;
      toastError(t('attachmentReadFailed', { name: file.name }));
    }
  }
}

// ---- 打开 / 关闭 ----
function resetForm(title: { icon: string; key: TextKey }) {
  openSeq++;
  const email = mailboxEmail();
  const [prefix, domain] = email ? email.split('@') : ['', ''];
  setC(s => {
    Object.assign(s, blank());
    s.titleIcon = title.icon;
    s.titleKey = title.key;
    s.fromPrefix = prefix || '';
    s.fromDomain = state.domains.includes(domain) ? domain : state.domains[0] || '';
  });
  getEditor().setContents([]);
}

function show() {
  visible = true;
  if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function close(clearDraft: boolean) {
  openSeq++;
  clearTimeout(draftTimer);
  visible = false;
  if (clearDraft) discardDraft();
  if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
}

function tryClose() {
  if (!isDirty()) {
    close(true);
    return;
  }
  showConfirm({ title: t('discardTitle'), message: t('discardMsg'), okLabel: t('discardOk'), onConfirm: () => close(true) });
}

export function openCompose() {
  resetForm({ icon: 'bi-pencil-square', key: 'composeEmail' });
  if (loadDraft()) setC(s => { s.draftBar = true; });
  show();
}

function quotedBody(msg: MessageDetail): string {
  if (msg.text?.trim()) return msg.text;
  const doc = new DOMParser().parseFromString(msg.html || '', 'text/html');
  doc.querySelectorAll('script, style, template, iframe, object, embed').forEach(el => el.remove());
  doc.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, tr, blockquote, h1, h2, h3, h4, h5, h6').forEach(el => el.append('\n'));
  return (doc.body.textContent || '').trim();
}

function quoteOriginal(msg: MessageDetail, origSubject: string) {
  const origDate = msg.createdAt ? new Date(msg.createdAt).toLocaleString(locale()) : '';
  const origFrom = msg.from?.address || '';
  const ed = getEditor();
  ed.setContents([]);
  ed.insertText(0, '\n\n');
  const quoteStart = ed.getLength();
  const quoteText = `--- Original Message ---\nFrom: ${origFrom}\nDate: ${origDate}\nSubject: ${origSubject}\n\n${quotedBody(msg)}`;
  ed.insertText(quoteStart, quoteText);
  ed.formatText(quoteStart, quoteText.length, 'color', '#6c757d');
  ed.setSelection(0, 0);
}

function openVariant(msg: MessageDetail, icon: string, key: TextKey, to: string[], subjectPrefix: string) {
  resetForm({ icon, key });
  const origSubject = msg.subject || '';
  setC(s => {
    s.recipients = uniqueAddresses(to);
    s.subject = origSubject.startsWith(subjectPrefix) ? origSubject : `${subjectPrefix}${origSubject}`;
  });
  quoteOriginal(msg, origSubject);
  show();
}

export const openReply = (msg: MessageDetail) =>
  openVariant(msg, 'bi-reply', 'replyEmail', [msg.from?.address || ''], 'Re: ');

export function openReplyAll(msg: MessageDetail) {
  const self = mailboxEmail().toLowerCase();
  const everyone = [msg.from?.address || '', ...(msg.to || []).map(addressText), ...(msg.cc || []).map(addressText)]
    .filter(addr => addr && addr.toLowerCase() !== self);
  openVariant(msg, 'bi-reply-all', 'replyAll', everyone, 'Re: ');
}

export const openForward = (msg: MessageDetail) => openVariant(msg, 'bi-arrow-right-short', 'forwardEmail', [], 'Fwd: ');

// ---- 发送 ----
const fail = (text: string) => setC(s => { s.alert = { kind: 'danger', text }; });

async function sendEmail() {
  setC(s => { s.alert = null; });
  // 收件人输入框里还没成 chip 的内容也一并收进来
  if (c.toInput.trim()) {
    addRecipients(c.toInput);
    setC(s => { s.toInput = ''; });
    flush();
  }
  const fromPrefix = c.fromPrefix.trim();
  const fromDomain = c.fromDomain;
  const subject = c.subject.trim();
  const ed = getEditor();
  const body = ed.getText().trim();
  if (!fromPrefix || !fromDomain) return fail(t('fillFrom'));
  if (c.recipients.length === 0) return fail(t('fillTo'));
  if (c.recipients.some(addr => !EMAIL_RE.test(addr))) return fail(t('invalidRecipient'));
  if (!subject) return fail(t('fillSubject'));
  if (!body) return fail(t('fillBody'));

  const fromEmail = `${fromPrefix}@${fromDomain}`;
  const seq = openSeq;
  setC(s => { s.send = 'sending'; });
  try {
    const data = await postJSON<Reply>('/api/send', {
      from_email: fromEmail,
      from_name: fromPrefix,
      to: c.recipients.join(','),
      subject,
      text: body,
      html: ed.root.innerHTML,
      reply_to: fromEmail,
      attachments: c.attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    if (seq !== openSeq) return;
    if (data.success) {
      setC(s => {
        s.alert = { kind: 'success', text: t('sentSuccess') };
        s.send = 'sent';
      });
      discardDraft();
      showToast(t('sentSuccess'), { type: 'success' });
      // 2秒后自动关闭弹窗（期间又打开了新的就不关）
      setTimeout(() => { if (seq === openSeq) close(true); }, 2000);
    } else {
      setC(s => { s.send = 'idle'; });
      fail(data.message || t('sendFailed'));
    }
  } catch (e) {
    if (seq !== openSeq) return;
    setC(s => { s.send = 'idle'; });
    fail(t('networkError') + ': ' + errorText(e));
  }
}

export function ComposeModal() {
  let toInput!: HTMLInputElement;
  let fileInput!: HTMLInputElement;
  const commitPending = () => {
    if (toInput.value.trim()) addRecipients(toInput.value);
    setC(s => { s.toInput = ''; });
    toInput.value = '';
  };
  return (
    <div class="modal fade" id="composeModal" tabindex="-1" aria-labelledby="composeModalLabel" aria-hidden="true"
         data-bs-backdrop="static" data-bs-keyboard="false" ref={el => { modalEl = el; }}>
      <div class="modal-dialog modal-lg modal-dialog-scrollable modal-fullscreen-md-down">
        <div class="modal-content">
          <div class="modal-header" style="background:rgba(245,249,247,0.95);border-bottom:1px solid var(--border-color);">
            <h5 class="modal-title" id="composeModalLabel"><i class={`bi ${c.titleIcon} me-2`}></i><span>{t(c.titleKey)}</span></h5>
            <button type="button" class="btn-close" onClick={tryClose} aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <Show when={c.alert}>
              {a => <div id="compose-alert" class={`alert alert-${a().kind}`} role="alert">{a().text}</div>}
            </Show>
            <Show when={c.draftBar}>
              <div id="compose-draft-bar" class="alert alert-warning d-flex align-items-center justify-content-between gap-2 py-2">
                <span class="small">{t('draftFound')}</span>
                <span class="d-flex gap-2">
                  <button type="button" class="btn btn-sm btn-primary" onClick={restoreDraft}>{t('restoreDraft')}</button>
                  <button type="button" class="btn btn-sm btn-outline-secondary" onClick={discardDraft}>{t('discardDraft')}</button>
                </span>
              </div>
            </Show>
            <div class="mb-3">
              <label class="form-label" for="compose-from-prefix">{t('from')}</label>
              <div class="input-group">
                <input type="text" class="form-control" id="compose-from-prefix" placeholder={t('prefix')} value={c.fromPrefix}
                       onInput={e => { setC(s => { s.fromPrefix = e.currentTarget.value; }); saveDraft(); }} />
                <span class="input-group-text">@</span>
                <select class="form-select" id="compose-from-domain" style="max-width:200px;"
                        ref={selectValue(() => c.fromDomain, () => state.domains.join())}
                        onChange={e => setC(s => { s.fromDomain = e.currentTarget.value; })}>
                  <Show when={state.domainsLoaded} fallback={<option value="">{t('loading')}</option>}>
                    <For each={state.domains}>{d => <option value={d}>{d}</option>}</For>
                  </Show>
                </select>
              </div>
            </div>
            <div class="mb-3">
              <label class="form-label" for="compose-to-input">{t('to')}</label>
              <div class={['chip-input', { 'is-focused': c.focused }]} id="compose-to-chips"
                   onClick={e => { if (!(e.target as Element).closest('.chip')) toInput.focus(); }}>
                <For each={c.recipients}>
                  {(addr, i) => (
                    <span class={['chip', { 'chip-invalid': !EMAIL_RE.test(addr) }]}>
                      <span class="chip-text">{addr}</span>
                      <button type="button" class="chip-remove" onClick={e => { e.stopPropagation(); removeRecipient(i()); }}>
                        <i class="bi bi-x-lg"></i>
                      </button>
                    </span>
                  )}
                </For>
                <input type="text" id="compose-to-input" placeholder={t('toPlaceholder')} ref={toInput} value={c.toInput}
                       onInput={e => setC(s => { s.toInput = e.currentTarget.value; })}
                       onKeyDown={e => {
                         if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
                           e.preventDefault();
                           commitPending();
                         } else if (e.key === 'Backspace' && !toInput.value && c.recipients.length > 0) {
                           removeRecipient(c.recipients.length - 1);
                         }
                       }}
                       onBlur={() => { commitPending(); setC(s => { s.focused = false; }); }}
                       onFocus={() => setC(s => { s.focused = true; })}
                       onPaste={e => {
                         const text = e.clipboardData?.getData('text');
                         if (text && /[,;\s]/.test(text)) {
                           e.preventDefault();
                           addRecipients(text);
                         }
                       }} />
              </div>
              <small class="text-muted">{t('toHint')}</small>
            </div>
            <div class="mb-3">
              <label class="form-label" for="compose-subject">{t('subject')}</label>
              <input type="text" class="form-control" id="compose-subject" placeholder={t('subjectPlaceholder')} value={c.subject}
                     onInput={e => { setC(s => { s.subject = e.currentTarget.value; }); saveDraft(); }} />
            </div>
            <div class="mb-3">
              <label class="form-label">{t('body')}</label>
              {/* Quill puts its toolbar next to the editor div: keep both in a wrapper Solid never patches */}
              <div><div id="compose-editor" style="min-height:200px;" ref={el => { editorEl = el; }}></div></div>
            </div>
            <div class="mb-1">
              <div class="d-flex align-items-center gap-2 mb-2">
                <button type="button" class="btn btn-sm btn-outline-secondary" onClick={() => fileInput.click()}>
                  <i class="bi bi-paperclip me-1"></i><span>{t('addAttachment')}</span>
                </button>
                <small class="text-muted" id="attachment-hint">
                  {c.attachments.length ? t('attachmentSummary', { n: c.attachments.length, size: formatSize(totalBytes()) }) : ''}
                </small>
              </div>
              <input type="file" id="compose-files" multiple style="display:none;" ref={fileInput} onChange={e => onAttachmentsPicked(e.currentTarget)} />
              <div id="compose-attachments" class="d-flex flex-wrap gap-2">
                <For each={c.attachments}>
                  {(att, i) => (
                    <span class="chip">
                      <span class="chip-text">{`${att.filename} (${formatSize(att.size)})`}</span>
                      <button type="button" class="chip-remove" onClick={() => setC(s => { s.attachments = s.attachments.filter((_, j) => j !== i()); })}>
                        <i class="bi bi-x-lg"></i>
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" onClick={tryClose}>{t('cancel')}</button>
            <button type="button" class="btn btn-primary" id="btn-send-email" disabled={c.send !== 'idle'} onClick={sendEmail}>
              <Show when={c.send === 'idle'}><i class="bi bi-send me-1"></i><span>{t('send')}</span></Show>
              <Show when={c.send === 'sending'}><span class="spinner-border spinner-border-sm me-1"></span>{t('sending')}</Show>
              <Show when={c.send === 'sent'}><i class="bi bi-check-lg me-1"></i>{t('sent')}</Show>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
