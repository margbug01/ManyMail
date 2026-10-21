// The /api/* JSON the Go viewer serves (viewer.go). Shapes are unchanged from the old app.js.

export interface Address { name?: string; address?: string }

export interface Attachment { id?: string; index?: number; filename?: string; size?: number }

export interface Message {
  id: string;
  from?: Address;
  subject?: string;
  intro?: string;
  createdAt?: string;
  seen?: boolean;
  extracted_code?: string;
}

export interface SentMessage {
  id: string;
  to?: string[];
  subject?: string;
  createdAt?: string;
  from_address?: string;
  html?: string;
  text?: string;
}

export interface MessageDetail extends Message {
  to?: (Address | string)[];
  cc?: (Address | string)[];
  text?: string;
  html?: string;
  attachments?: Attachment[];
}

export interface Reply { success: boolean; message?: string }
export interface ListReply<T> extends Reply { messages: T[]; total?: number }

export async function postJSON<T extends Reply>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

export async function getJSON<T extends Reply>(url: string, method = 'GET'): Promise<T> {
  return (await fetch(url, { method })).json();
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
