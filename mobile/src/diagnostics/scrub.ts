/**
 * What a crash report is allowed to contain.
 *
 * This is a privacy product, and a crash report is the one payload that leaves
 * the device without anyone deciding to send it. The web client's reporter
 * forwards `message`, `stack`, `componentStack` and `url` verbatim; on a phone
 * that is worse than on a desktop, because:
 *
 *   - an `ApiError`'s message is *the server's own error string*, which on this
 *     product routinely quotes a document name, a knowledge-base title or the
 *     first line of a prompt;
 *   - `url` is the expo-router path, and every interesting path here carries an
 *     id — `/chat/<conversationId>`, `/notebooks/<id>`, `/approvals/<id>`.
 *     That id is a direct index into someone's content, so this reporter does
 *     not send a route at all. There is no scrubbed version of a URL that is
 *     both useful for debugging and safe here, so the field is simply dropped;
 *   - a JS `SyntaxError` from a JSON parse embeds the input it choked on.
 *
 * So: everything that looks like an identifier, an address, a secret or a
 * verbatim quote is replaced before the report is built, and the result is
 * truncated. A stack trace gets the lighter pass — its `file:line:column`
 * frames are the entire point of sending it, and the aggressive pass would eat
 * them.
 *
 * The rule this file follows: when in doubt, redact. A crash we can only
 * half-diagnose is a cost; a crash report that carries a customer's contract
 * title into a log line is an incident.
 */

/** Redaction markers. Distinct strings so a log reader can see WHY it went. */
const EMAIL = '<email>';
const URL = '<url>';
const ID = '<id>';
const TOKEN = '<token>';
const QUOTED = '<quoted>';
const NUMBER = '<number>';

const PATTERNS_ALWAYS: [RegExp, string][] = [
    // An email is the single most identifying thing a message can carry.
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, EMAIL],
    // JWTs — three base64url segments. The bridge token is one of these, and it
    // is a live credential until it expires.
    [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, TOKEN],
    // UUIDs: conversation ids, message ids, notebook ids, approval ids.
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ID],
    // Long unbroken runs that mix letters and digits — API keys, encoded
    // blobs, opaque ids. The digit requirement is deliberate: it is what keeps
    // a long camelCase frame name in a stack trace readable while still
    // catching anything that looks generated.
    [/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g, TOKEN],
    // Digests, which can be all letters (a `deadbeef…` run has no digit).
    [/\b[a-f0-9]{32,}\b/gi, TOKEN],
];

const PATTERNS_MESSAGE: [RegExp, string][] = [
    // Any absolute URL. Even the origin is worth losing: a self-hosted
    // deployment's hostname is often the customer's own name.
    [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, URL],
    // Anything the runtime or the server quoted back at us. This is where a
    // document title, a prompt fragment or a row of a spreadsheet arrives.
    // The 8-character floor keeps the short quoted spans that are always code
    // rather than content — the `'x'` in "Cannot read property 'x' of
    // undefined" is the most useful word in that sentence.
    [/"[^"]{8,400}"/g, `"${QUOTED}"`],
    [/'[^']{8,400}'/g, `'${QUOTED}'`],
    // Standalone digit runs: phone numbers, order numbers, BSNs, invoice ids.
    // Short runs stay — an HTTP status or an array index is diagnostic.
    [/\b\d{7,}\b/g, NUMBER],
];

function apply(text: string, patterns: [RegExp, string][]): string {
    let out = text;
    for (const [pattern, replacement] of patterns) out = out.replace(pattern, replacement);
    return out;
}

export function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…[truncated]`;
}

/**
 * The aggressive pass, for anything a human or a server wrote: error messages,
 * React component stacks, labels.
 */
export function scrubMessage(input: unknown, max = 600): string {
    const text = typeof input === 'string' ? input : String(input ?? '');
    return truncate(apply(apply(text, PATTERNS_ALWAYS), PATTERNS_MESSAGE), max);
}

/**
 * The lighter pass, for a JS stack trace.
 *
 * Frames read `at fnName (/abs/path/index.android.bundle:1234:56)`, and the
 * message pass would replace the whole frame with `<url>` and every bundle
 * offset with `<number>` — leaving a report that says only that something threw.
 * Secrets and addresses still go; paths and offsets stay.
 */
export function scrubStack(input: unknown, max = 4000): string {
    const text = typeof input === 'string' ? input : String(input ?? '');
    return truncate(apply(text, PATTERNS_ALWAYS), max);
}
