/**
 * The company mailbox, parsing side: a mailparser result as the ingest needs
 * it, the raw header block of an over-size message, the UID window after the
 * cursor, and the masked address staff notices show. No I/O.
 */

export interface NormalizedMail {
    providerMessageId: string;
    rfc822MessageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: string;
    fromName: string;
    subject: string;
    text: string;
    html: string;
    attachments: Array<{ filename: string; mimeType: string; size: number }>;
    getHeader: (name: string) => string;
}

interface ParsedAddress { value?: Array<{ address?: string; name?: string }> }
export interface ParsedMail {
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    from?: ParsedAddress;
    subject?: string;
    text?: string;
    html?: string | false;
    attachments?: Array<{ filename?: string; contentType?: string; size?: number }>;
    headerLines?: Array<{ key: string; line: string }>;
}

const firstAddress = (a: ParsedAddress | undefined) => a?.value?.find((v) => v.address) ?? null;

/**
 * A parsed RFC 822 message as the ingest needs it. The requester is From,
 * never Reply-To: Reply-To is not covered by SPF/DKIM/DMARC, so taking it
 * would let anyone have our SMTP account (and the AI) mail a third party.
 */
export function normalizeParsed(p: ParsedMail, { uid, uidValidity }: { uid: number; uidValidity: string }): NormalizedMail {
    const lines = p.headerLines || [];
    const getHeader = (name: string): string => {
        const key = name.toLowerCase();
        const hit = lines.find((h) => h.key === key);
        if (!hit) return '';
        const i = hit.line.indexOf(':');
        return i < 0 ? '' : hit.line.slice(i + 1).trim();
    };
    const sender = firstAddress(p.from);
    const refs = Array.isArray(p.references) ? p.references : String(p.references || '').split(/\s+/);
    return {
        providerMessageId: `imap:${uidValidity}:${uid}`,
        rfc822MessageId: p.messageId || null,
        inReplyTo: p.inReplyTo || null,
        references: refs.map((r) => r.trim()).filter(Boolean),
        from: String(sender?.address || '').toLowerCase(),
        fromName: String(sender?.name || ''),
        subject: String(p.subject || '').trim() || '(no subject)',
        text: p.text || '',
        html: typeof p.html === 'string' ? p.html : '',
        attachments: (p.attachments || []).map((a) => ({ filename: String(a.filename || 'attachment'), mimeType: String(a.contentType || ''), size: Number(a.size) || 0 })),
        getHeader,
    };
}

/** Raw header block → mailparser-style header lines (unfolded, key lower-cased). */
export function headerLinesOf(raw: string): Array<{ key: string; line: string }> {
    const out: Array<{ key: string; line: string }> = [];
    for (const physical of raw.split('\r\n').join('\n').split('\n')) {
        if (!physical) continue;
        const first = physical[0];
        if ((first === ' ' || first === '\t') && out.length) { out[out.length - 1].line += ` ${physical.trim()}`; continue; }
        const i = physical.indexOf(':');
        if (i > 0) out.push({ key: physical.slice(0, i).trim().toLowerCase(), line: physical });
    }
    return out;
}

/** The UIDs after the cursor, oldest first, at most `max` (0 = all). `n:*` also returns the newest message when it is below n. */
export function pickUids(found: number[], lastUid: number | null, max: number): number[] {
    const after = lastUid ?? 0;
    const uids = Array.from(new Set(found)).filter((u) => u > after).sort((a, b) => a - b);
    return max > 0 ? uids.slice(0, max) : uids;
}

/** The address in a staff notification: enough to recognise, not the address itself. */
export function maskAddress(addr: string): string {
    const at = addr.indexOf('@');
    if (at < 1) return `${addr.slice(0, 3)}***`;
    return `${addr.slice(0, Math.min(2, at))}***@${addr.slice(at + 1).split('.')[0].slice(0, 1)}***`;
}
