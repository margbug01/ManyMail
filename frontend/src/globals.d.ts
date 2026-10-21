// Classic scripts loaded by web/templates/index.html before the app module.

interface ManyMailLanguage { code: string; name: string; short: string; locale: string; fallback?: string }

declare const ManyMailI18n: {
  languages: ManyMailLanguage[];
  detect(): string;
  normalize(code: string | null | undefined): string | null;
  save(code: string): void;
  info(code: string): ManyMailLanguage;
  locale(code: string): string;
  dict<T>(code: string, section: string, base: Record<string, T>): T;
};

declare const EmailPrivacy: {
  freshFrame(iframe: HTMLIFrameElement): HTMLIFrameElement;
  control(iframe: HTMLIFrameElement, html: string, allowImages: boolean, render: (allowed: boolean) => void): void;
  prepare(html: string, allowImages: boolean): string;
  head(allowImages: boolean): string;
  relabel(root?: ParentNode): void;
};

interface BootstrapModal { show(): void; hide(): void }

declare const bootstrap: {
  Modal: { getOrCreateInstance(el: Element): BootstrapModal };
  Offcanvas: { getInstance(el: Element): { hide(): void } | null };
};

interface QuillEditor {
  root: HTMLElement;
  clipboard: { dangerouslyPasteHTML(html: string): void };
  on(event: 'text-change', handler: () => void): void;
  getText(): string;
  getLength(): number;
  setContents(delta: unknown[]): void;
  insertText(index: number, text: string): void;
  formatText(index: number, length: number, format: string, value: unknown): void;
  setSelection(index: number, length: number): void;
}

declare const Quill: new (el: Element, options: unknown) => QuillEditor;
