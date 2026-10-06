/**
 * What a record IS, for auto-map's one guess that is not a name match: an
 * input `<x>Id` gets a record's own `id` only when the record is an x.
 *
 * The evidence, in the order a person would look:
 *   - its names: the list it comes from and its item variable (`messages`,
 *     `loop.order`, `line_items` → message, order, line item);
 *   - its type field (Stripe `object: "invoice"`, Graph `@odata.type:
 *     "#microsoft.graph.message"`, Google `kind: "drive#file"`);
 *   - a mail's headers: a subject plus a sender or a thread is a message,
 *     whatever the list is called (Gmail search answers `results`).
 * A mail is also called a message or an e-mail, so those count as one word.
 *
 * Without this, a Slack post below a list of mails got channelId = the
 * mail's id, and a Jira issue projectId = the mail's id: confident values
 * that fail at run time or hit the wrong resource. Left empty, the author is
 * asked. Pure. Port of agent-hub `Builder/mapping/autoMapEntity.ts`; pinned
 * by autoMap.lockstep.test.ts.
 */
import { getPath, splitLast } from '@/shared/expr';

import { foldKey, isRecord } from './deepFields';

// Names one kind of record goes by: a mail is a message is an e-mail.
const ENTITY_ALIASES = [['message', 'mail', 'email', 'msg'], ['file', 'document', 'doc']];
// Keys whose value says what a record IS.
const TYPE_KEYS = ['object', 'kind', 'type', 'entityType', 'resourceType', '@odata.type'];
// Beside a subject, a key only a mail carries (folded).
const MAIL_HEADERS = new Set(['from', 'sender', 'fromemail', 'fromaddress', 'threadid', 'conversationid', 'inreplyto']);

/** A folded word in its singular form: `entries` → entry, `addresses` → address, `line_items` → lineitem. */
function singular(w: string): string {
    if (w.length <= 3) return w;
    if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
    if (/(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
    if (/(ss|us|is)$/.test(w)) return w;
    return w.endsWith('s') ? w.slice(0, -1) : w;
}

/** One entity word, folded and singular, by its first alias: `Messages`, `mail` → message. */
export function entityWord(word: unknown): string {
    const one = singular(foldKey(word));
    return (ENTITY_ALIASES.find((names) => names.includes(one)) || [one])[0] as string;
}

/** Is this record a mail? A subject and a sender (or a thread) say so. */
function looksLikeMail(el: Record<string, unknown>): boolean {
    const keys = Object.keys(el).map((k) => foldKey(k));
    return keys.includes('subject') && keys.some((k) => MAIL_HEADERS.has(k));
}

/** The entity words of a record: the names it goes by and what it says about itself. */
export function entityWords(names: unknown[], element: unknown): Set<string> {
    const words = new Set(names.map(entityWord));
    if (isRecord(element)) {
        for (const k of TYPE_KEYS) {
            const v = element[k];
            if (typeof v === 'string') words.add(entityWord(v.split(/[#.:/]/).filter(Boolean).pop() || ''));
        }
        if (looksLikeMail(element)) words.add('message');
    }
    words.delete('');
    return words;
}

/** Does the id key's base (`message` of `messageId`) name a record with these words? */
export function namesRecord(base: string | null, words: Set<string>): boolean {
    return !!base && words.has(entityWord(base));
}

/**
 * The element's own `id` among its fields, and what the record it belongs to
 * IS. Only an id directly on the element, or under wrapper keys only (the
 * `output` of one run of a per-item step, a JSON:API `data`: weight 1 in
 * deepFields), is the element's: `customer.id` is the customer's id, never
 * the order's. `names` are what the element goes by (its list, its item
 * variable); the type field and the mail headers are read from the record
 * that holds the id.
 */
export function recordIdOf<F extends { key: string; path: string; weight: number }>(
    fields: readonly F[], basePath: string, element: unknown, names: unknown[],
): { field: F; words: Set<string> } | null {
    const field = fields.find((f) => f.key === 'id' && f.weight === 1);
    if (!field) return null;
    const parent = splitLast(field.path)?.parent ?? '';
    const record = parent !== basePath && parent.startsWith(basePath) ? getPath({ $: element }, `$${parent.slice(basePath.length)}`) : element;
    return { field, words: entityWords(names, record) };
}
