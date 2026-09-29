/**
 * What may leave Bee Flow for a YouTrack issue — and nothing else.
 *
 * The rule (CLAUDE.md → Security): personal data does not leave the product,
 * except over email, where the customer's own address is the channel. YouTrack
 * is not that exception. It gets the ticket reference, a description an agent
 * wrote, and a staff-only link back.
 *
 * Two controls, deliberately of different kinds:
 *
 *   1. CONSTRUCTION. `buildIssuePayload` assembles the payload from an explicit
 *      allow-list of thread fields. It never receives the thread row wholesale
 *      and deletes from it — a deny-list silently goes out of date the day
 *      someone adds a column, and the failure mode of that is a leak. This
 *      control is deterministic and always on.
 *
 *   2. INSPECTION. `screenText` looks at the free text an agent typed, where
 *      construction can't help. First an exact match against the identifiers
 *      this very ticket holds (no service needed, no false positives), then the
 *      PII guard for the general case.
 *
 * Control 2 fails open when the guard isn't installed — a self-hoster without
 * it would otherwise be unable to file an issue at all — and says so in its
 * result, so the caller can record that no scan ran. Control 1 does not fail
 * open, because it cannot fail.
 */

const { detectPii } = require('../core/privacy/piiDetection/detect');
const configStore = require('../stores/configStore');
const log = require('../telemetry/log');

/**
 * Categories that mean "a person is identifiable here". `URL` is absent on
 * purpose: the payload carries our own staff link by design. `ApiKeyOrSecret`
 * is absent because a leaked credential is a real problem but a different one,
 * and folding it in here would make this gate's failures hard to read.
 */
const BLOCKED_PII_CATEGORIES = [
    'Person', 'DateOfBirth', 'PhoneNumber', 'Email', 'Address',
    'CreditCardNumber', 'BankAccountNumber', 'InternationalBankingAccountNumber',
    'USSocialSecurityNumber', 'PassportNumber', 'DriversLicenseNumber',
    'IPAddress', 'Organization',
    'NationalIdentificationNumber', 'TaxIdentificationNumber',
    'HealthInsuranceNumber', 'MedicalCondition', 'Medication', 'LicensePlateNumber',
];

// Admin setting: may the ticket subject travel to an external system? Off by
// default — a support subject carries a name often enough ("Re: invoice for
// J. de Vries") that the safe starting position is closed. One setting for
// every destination, so YouTrack and chat cannot drift apart.
const SUBJECT_KEY = 'support_external_include_subject';

// getConfig JSON-parses the stored 'true' into the boolean true.
async function includeSubjectEnabled() {
    const stored = await configStore.getConfig(SUBJECT_KEY);
    return stored === true || stored === 'true';
}

const MAX_SUMMARY = 250;
const MAX_DESCRIPTION = 20_000;

const { clientHost, adminSupportTicketPath } = require('../utils/appPaths');

/** The staff-only deep link. An opaque id behind the admin_support gate. */
function staffTicketUrl(threadId) {
    return `${clientHost()}${adminSupportTicketPath(threadId)}`;
}

/**
 * Assemble what goes to YouTrack.
 *
 * Reads exactly four things off the thread — id, ticket_ref, source, created_at
 * — plus the subject when an admin has turned that on. Everything else on
 * `support_threads` (requester_email, requester_name, requester_org_name,
 * requester_ip, requester_ua, …) is unreachable from here by construction.
 *
 * @param {object}  p.thread          a support_threads row
 * @param {string}  p.summary         the agent's issue title
 * @param {string}  p.description     the agent's problem description
 * @param {boolean} p.includeSubject  admin setting; appends the ticket subject
 * @returns {{summary: string, description: string, ticketRef: string, url: string}}
 */
function buildIssuePayload({ thread, summary, description = '', includeSubject = false }) {
    if (!thread || !thread.id) throw new Error('thread is required');
    const ticketRef = thread.ticket_ref || null;
    if (!ticketRef) throw new Error('thread has no ticket_ref — run the store migration');

    const cleanSummary = String(summary || '').trim().slice(0, MAX_SUMMARY);
    if (!cleanSummary) throw new Error('summary is required');

    const url = staffTicketUrl(thread.id);
    const lines = [
        String(description || '').trim().slice(0, MAX_DESCRIPTION),
        '',
        '---',
        `Bee Flow support ticket: **${ticketRef}**`,
        `Source: ${thread.source || 'unknown'}`,
        thread.created_at ? `Opened: ${new Date(thread.created_at).toISOString().slice(0, 10)}` : null,
        `Ticket (Bee Flow staff only): ${url}`,
        '',
        '_Who reported this is deliberately not in this issue. Open the ticket above to see it._',
    ];
    if (includeSubject && thread.subject) {
        lines.splice(4, 0, `Subject: ${String(thread.subject).trim().slice(0, MAX_SUMMARY)}`);
    }

    return {
        summary: cleanSummary,
        description: lines.filter(l => l !== null).join('\n'),
        ticketRef,
        url,
    };
}

/** Escape a literal for use inside a RegExp. */
function reEscape(v) {
    return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Name particles that identify nobody on their own and appear constantly in
 * ordinary Dutch, German and French prose. Matching them would block every
 * second sentence an agent writes.
 */
const NAME_PARTICLES = new Set([
    'de', 'den', 'der', 'van', 'von', 'het', 'ten', 'ter', 'te', 'op', 'aan',
    'la', 'le', 'les', 'du', 'des', 'di', 'da', 'do', 'dos', 'el', 'al', 'bin',
    'the', 'and', 'for',
]);

/**
 * The identifiers THIS ticket holds, as literal strings worth searching for.
 * Cheap, exact, no service, no false positives — and it catches the single most
 * likely mistake, which is an agent pasting the customer's own words in.
 *
 * Two matching modes, because the strings are not alike:
 *
 *   'substring' — an address, an organisation, an IP. Unambiguous wherever it
 *                 appears, so a plain contains() is right.
 *   'word'      — one part of a name. "Jan" is three characters and matching it
 *                 as a substring would hit "January" and "Janssen"; matching it
 *                 as a whole word hits the customer and not much else. That is
 *                 what lets the floor drop to two characters, which matters
 *                 because Dutch first names are short.
 */
function knownIdentifiers(thread) {
    const out = [];
    const substring = (v, label) => {
        const s = String(v || '').trim();
        if (s.length >= 4) out.push({ value: s, label, mode: 'substring' });
    };
    substring(thread?.requester_email, 'email address');
    substring(thread?.requester_org_name, 'organisation');
    substring(thread?.requester_ip, 'IP address');

    const name = String(thread?.requester_name || '').trim();
    if (name.length >= 2) {
        out.push({ value: name, label: 'customer name', mode: 'substring' });
        for (const part of name.split(/\s+/)) {
            if (part.length >= 2 && !NAME_PARTICLES.has(part.toLowerCase())) {
                out.push({ value: part, label: 'customer name', mode: 'word' });
            }
        }
    }

    // The local part of an address is frequently the person: jan.devries@…
    const email = String(thread?.requester_email || '').trim();
    const at = email.indexOf('@');
    if (at >= 3) out.push({ value: email.slice(0, at), label: 'email address', mode: 'substring' });

    return out;
}

/**
 * Does `haystack` contain this identifier? Unicode-aware word boundaries, so a
 * name with diacritics ("José", "Müller") behaves like any other — JS's own
 * \b is ASCII-only and would split those in the middle.
 */
function identifierPresent(haystack, { value, mode }) {
    if (mode === 'word') {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${reEscape(value)}(?![\\p{L}\\p{N}])`, 'iu');
        return re.test(haystack);
    }
    return haystack.toLowerCase().includes(String(value).toLowerCase());
}

/**
 * Screen free text before it leaves.
 *
 * @returns {{ok: boolean, scanned: boolean, findings: Array<{category: string, label: string, count: number}>}}
 *   `ok:false` means do not send. `scanned:false` means the PII guard was not
 *   available and only the exact-match pass ran — record that, because it is
 *   the difference between "checked and clean" and "could not check".
 */
async function screenText(text, { thread = null } = {}) {
    const findings = [];
    const haystack = String(text || '');
    if (!haystack.trim()) return { ok: true, scanned: true, findings };

    // Pass 1 — exact identifiers from this ticket.
    const seen = new Set();
    for (const ident of knownIdentifiers(thread)) {
        const key = `${ident.label}:${ident.value.toLowerCase()}`;
        if (seen.has(key)) continue;
        if (identifierPresent(haystack, ident)) {
            seen.add(key);
            // One finding per label: an agent needs to know "the customer's
            // name is in here", not that it appears in four forms.
            if (!findings.some(f => f.category === 'KnownIdentifier' && f.label === ident.label)) {
                findings.push({ category: 'KnownIdentifier', label: ident.label, count: 1 });
            }
        }
    }

    // Pass 2 — the guard, for everything this ticket doesn't already know about.
    let scanned = true;
    try {
        const result = await detectPii(haystack, BLOCKED_PII_CATEGORIES);
        if (result === null) {
            // Guard not installed or unreachable. detectPii already fails open
            // for the chat path; here it means "unscanned", not "clean".
            scanned = false;
        } else if (result.hasPii && Array.isArray(result.entities)) {
            const counts = new Map();
            for (const e of result.entities) {
                const cat = e?.category || e?.entity_type || e?.label;
                if (!cat || !BLOCKED_PII_CATEGORIES.includes(cat)) continue;
                counts.set(cat, (counts.get(cat) || 0) + 1);
            }
            for (const [category, count] of counts) {
                findings.push({ category, label: category, count });
            }
        }
    } catch (err) {
        log.warn('[SupportEgress] PII scan failed:', err.message);
        scanned = false;
    }

    return { ok: findings.length === 0, scanned, findings };
}

/** One line an agent can act on: what was found and where. */
function describeFindings(findings = []) {
    if (!findings.length) return '';
    return findings
        .map(f => (f.category === 'KnownIdentifier'
            ? `the customer's ${f.label}`
            : `${f.label}${f.count > 1 ? ` (${f.count})` : ''}`))
        .join(', ');
}

module.exports = {
    BLOCKED_PII_CATEGORIES,
    SUBJECT_KEY,
    includeSubjectEnabled,
    buildIssuePayload,
    staffTicketUrl,
    knownIdentifiers,
    identifierPresent,
    screenText,
    describeFindings,
};
