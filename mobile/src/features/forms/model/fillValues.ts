/**
 * The small rules of filling a form in, from the web's PublicFormPage.jsx and
 * PublicFormRenderer.jsx (fillValues.lockstep.test.ts cuts the web functions
 * out of their source and runs them beside these): a file's size and type as
 * a card shows them, when a closing page is long enough to be worth keeping,
 * the replay nonce, and the pacing of the poll while the routine works.
 */

/** Human file size. 1 decimal from MB up, none below — "0.9 kB" reads as noise. */
export function fileSize(bytes: unknown): string {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The extension, upper-cased, as a type chip: PDF, DOCX. */
export function fileKind(filename: unknown): string {
    const m = /\.([a-z0-9]{1,5})$/i.exec(String(filename || ''));
    return m ? (m[1] as string).toUpperCase() : '';
}

/**
 * Short closings ("Thanks!") stay centred under the tick; a long one is a
 * document — the routine's real output — and gets the export bar, because
 * closing the screen would otherwise lose it for good.
 */
export const LONG_ENDING_CHARS = 240;
export const isLongEnding = (text: string | null | undefined): boolean => (text ?? '').length > LONG_ENDING_CHARS;

/** A safe, boring .txt filename from the closing page's own title. */
export function txtFilename(title: unknown): string {
    const base = String(title || 'result')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return `${base || 'result'}.txt`;
}

/**
 * One nonce per rendered page: a double tap reuses it and the server answers
 * "already got that" instead of running the routine twice. The server takes
 * `[A-Za-z0-9_-]{8,80}`.
 */
export function newNonce(random: () => number = Math.random, now: () => number = Date.now): string {
    const part = () => Math.floor(random() * 0xffffffff).toString(36);
    return `n${now().toString(36)}${part()}${part()}`;
}

/**
 * The server answers a submission sent within two seconds of the page being
 * handed out with a SILENT 200 that runs nothing (formPublic.js's bot check).
 * A person on a phone can tap a one-checkbox form faster than that, so the
 * send waits out the rest of the two seconds rather than being swallowed.
 */
export const MIN_FORM_AGE_MS = 2000;
export function submitDelay(receivedAt: number, now: number): number {
    return Math.max(0, receivedAt + MIN_FORM_AGE_MS - now);
}

/**
 * Poll cadence while the routine works: sub-second at first so a fast
 * routine feels instant, easing off so a slow one is not hammered, and a
 * ceiling after which the screen offers "Check again" instead of spinning.
 */
export const POLL_MIN_MS = 700;
export const POLL_MAX_MS = 2000;
export const POLL_STEP_MS = 200;
export const POLL_CEILING_MS = 5 * 60 * 1000;
export const nextPollDelay = (delay: number): number => Math.min(POLL_MAX_MS, delay + POLL_STEP_MS);

/** The session id's shape (formPublic.js SESSION_RE); anything else is not resumed. */
export const SESSION_RE = /^[a-f0-9]{24,64}$/;
/** A form token's shape (formPublic.js loadForm): 24–64 hex characters. */
export const TOKEN_RE = /^[a-f0-9]{24,64}$/;
