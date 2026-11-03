/**
 * XML files and forwarded mails (message/rfc822), read as TEXT for the AI only.
 *
 * A purchase order often arrives as an .xml attachment, and a customer forwards
 * the original mail as an .eml. materializeAttachment refuses both for storage
 * (REFUSED_MIME: Bee Flow never serves a stranger's markup back to a browser),
 * which made the whole AI step fail. This module is the other half of that
 * decision: the bytes are turned into plain text and handed to the model, and
 * NOTHING is persisted, so there is no stored object that could be served.
 *
 *   - XML is read as text. It is never parsed: no DTD, no entity expansion.
 *   - A mail yields From/To/Subject/Date, the text body (mailparser derives it
 *     from the HTML part when there is no text part) and the NAMES of its
 *     attachments. Its attachments are not opened, not recursed into.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** The extracted text is capped here already; callers cut it to their own budget. */
export const MAX_TEXT_CHARS = 200_000;
const MAX_LISTED_ATTACHMENTS = 50;

const XML_MIMES = new Set(['application/xml', 'text/xml']);
const MAIL_MIMES = new Set(['message/rfc822']);

export type InlineTextDescriptor = {
    kind: 'inline_text';
    name: string;
    mime: string;
    text: string;
};

function extOf(name: unknown): string {
    const s = String(name ?? '').slice(-260).toLowerCase();
    const dot = s.lastIndexOf('.');
    return dot < 0 ? '' : s.slice(dot + 1);
}

/** 'xml' | 'mail' when this type/name is read as text only, else null. */
export function textOnlyKind(mime: unknown, name: unknown): 'xml' | 'mail' | null {
    const m = String(mime ?? '').split(';')[0].trim().toLowerCase();
    if (XML_MIMES.has(m)) return 'xml';
    if (MAIL_MIMES.has(m)) return 'mail';
    if (m === '' || m === 'application/octet-stream' || m === 'application/binary' || m === 'binary/octet-stream') {
        const ext = extOf(name);
        if (ext === 'xml') return 'xml';
        if (ext === 'eml') return 'mail';
    }
    return null;
}

function stripControl(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function decodeXml(buf: Buffer): string {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    const text = buf.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

type Addr = { text?: string } | Array<{ text?: string }> | undefined;
function addrText(a: Addr): string {
    if (!a) return '';
    return (Array.isArray(a) ? a.map((x) => x.text || '').join('; ') : a.text || '').slice(0, 500);
}

async function mailToText(buf: Buffer): Promise<string> {
    const { simpleParser } = nodeRequire('mailparser') as { simpleParser: (b: Buffer) => Promise<{
        from?: Addr; to?: Addr; cc?: Addr; subject?: string; date?: Date; text?: string;
        attachments?: Array<{ filename?: string; contentType?: string }>;
    }> };
    const mail = await simpleParser(buf);
    const lines: string[] = [];
    const add = (label: string, value: string) => { if (value) lines.push(`${label}: ${value.slice(0, 500)}`); };
    add('From', addrText(mail.from));
    add('To', addrText(mail.to));
    add('Cc', addrText(mail.cc));
    add('Subject', String(mail.subject || ''));
    add('Date', mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : '');
    lines.push('', String(mail.text || '').trim());
    const names = (mail.attachments || []).slice(0, MAX_LISTED_ATTACHMENTS)
        .map((a) => `${String(a.filename || 'unnamed').slice(0, 200)} (${String(a.contentType || 'unknown').slice(0, 100)})`);
    if (names.length) lines.push('', `Attachments of this mail (not opened): ${names.join(', ')}`);
    return lines.join('\n');
}

/** The model-facing text of an xml or mail attachment. Throws on bytes that are not a mail. */
export async function bytesToModelText(buf: Buffer, kind: 'xml' | 'mail'): Promise<string> {
    const raw = kind === 'xml' ? decodeXml(buf) : await mailToText(buf);
    return stripControl(raw).slice(0, MAX_TEXT_CHARS);
}

/**
 * The transient descriptor handed to the AI instead of a stored file. It lives
 * for one step run and is never written to the ledger or the storage.
 */
export async function inlineTextDescriptor(
    buffer: Buffer,
    { name, mime, scan }: { name: string; mime: string; scan?: (b: Buffer) => Promise<{ clean?: boolean } | undefined | void> },
): Promise<InlineTextDescriptor> {
    const kind = textOnlyKind(mime, name);
    if (!kind) throw Object.assign(new Error('That file type is not supported'), { status: 415 });
    const verdict = scan ? await scan(buffer) : undefined;
    if (verdict && verdict.clean === false) {
        throw Object.assign(new Error('That file did not pass the malware scan'), { status: 422 });
    }
    let text: string;
    try {
        text = await bytesToModelText(buffer, kind);
    } catch {
        throw Object.assign(new Error('That file could not be read as text'), { status: 422 });
    }
    return { kind: 'inline_text', name: String(name || (kind === 'xml' ? 'attachment.xml' : 'mail.eml')).slice(0, 200), mime: kind === 'xml' ? 'application/xml' : 'message/rfc822', text };
}
