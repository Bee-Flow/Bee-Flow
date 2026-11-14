/**
 * noteText.mts: the text a meeting-notes pipeline writes into a note's
 * `summary` column besides the summary itself: the reason a run failed, and the
 * notice lines (⚠️ / ℹ️) placed in front of the summary.
 *
 * The summary column is read by everyone the note reaches (the owner, shared
 * users and groups, project members), so what goes there is written for them.
 */

const NOTICE_MARK = /^(?:⚠|ℹ)️?/;

/** The longest failure reason a note carries; the full error is in the log. */
const MAX_REASON = 300;

/**
 * One line of an error message, safe to show to the readers of a note.
 *
 * An engine wrapper puts the upstream response body into its message
 * ("WhisperX service error (500): <body>"), and that body can be a stack trace
 * naming internal hosts, paths or a connection string with credentials. The
 * status survives, the body does not; the raw message stays in the server log.
 * What remains is redacted of URLs, addresses and key-like tokens, and cut.
 */
export function failureReason(err: unknown): string {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    let text = String(raw || '').split(/\r?\n/)[0].trim();
    // "<Engine> service error (502): <upstream body>" → keep up to the status.
    const upstream = /^(.{0,80}?\b(?:service|API|server|request) error\s*\(\d{3}\))\s*:/i.exec(text);
    if (upstream) text = upstream[1];
    text = text
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[address]')
        .replace(/\b[\w.-]+\.(?:internal|local|lan|corp|svc|cluster\.local)(?::\d+)?\b/gi, '[address]')
        .replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]')
        .trim();
    if (text.length > MAX_REASON) text = `${text.slice(0, MAX_REASON - 1).trimEnd()}…`;
    return text || 'unknown error';
}

/** `Transcription failed: <reason>`, the summary of a failed note. */
export function failureSummary(err: unknown): string {
    return `Transcription failed: ${failureReason(err)}`;
}

/**
 * Split a stored summary into the notice lines at its top and the rest.
 * The pipelines write `notices.join('\n') + '\n\n' + summary`, so the notices
 * are the leading lines that start with ⚠️ or ℹ️, up to the first line that
 * does not.
 */
export function leadingNotices(summary: unknown): { notices: string[]; body: string } {
    const lines = typeof summary === 'string' ? summary.split('\n') : [];
    const notices: string[] = [];
    let i = 0;
    while (i < lines.length && NOTICE_MARK.test(lines[i].trim())) {
        notices.push(lines[i].trim());
        i += 1;
    }
    return { notices, body: lines.slice(i).join('\n').trim() };
}

/** Notices first, then the summary, the way the pipelines write it. */
export function withNotices(notices: string[], summary: string): string {
    return notices.length ? `${notices.join('\n')}\n\n${summary || ''}`.trim() : summary;
}

/**
 * The notice for a run whose summary step produced nothing. `kept` says
 * whether the note still carries an earlier summary below it.
 */
export function summaryFailedNotice(language: unknown, kept: boolean): string {
    const nl = String(language || 'nl').toLowerCase().startsWith('nl');
    if (nl) {
        return kept
            ? `⚠️ Het schrijven van een nieuwe samenvatting is niet gelukt; de vorige samenvatting is bewaard. Probeer 'Opnieuw'.`
            : `⚠️ Het schrijven van de samenvatting is niet gelukt. Probeer 'Opnieuw'.`;
    }
    return kept
        ? `⚠️ Writing a new summary failed; the previous summary has been kept. Try 'Regenerate'.`
        : `⚠️ Writing the summary failed. Try 'Regenerate'.`;
}
