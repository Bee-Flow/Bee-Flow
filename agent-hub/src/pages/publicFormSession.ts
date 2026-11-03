import { logger } from '../utils/logger';
/**
 * The hosted form page's session plumbing: fetching a journey, mapping a poll
 * answer onto the page's phase, and mirroring the session id into the URL.
 * No React in here; the page owns the state and passes its setters in.
 */

export const FORM_API: string = `${import.meta.env.VITE_API_URL || ''}/api/automation/form`;

/** What the poll sends. Only `state` is always there. */
export interface SessionPayload {
    state?: string;
    form?: { theme?: Record<string, unknown> | null } & Record<string, unknown>;
    csrf?: string;
    issuedAt?: number;
    ending?: { theme?: Record<string, unknown> | null } & Record<string, unknown>;
    progress?: string[];
    progressNote?: string | null;
    /** The median length of this form's recent runs, in seconds. */
    typicalSeconds?: number;
    /** A test journey (a test link's, or the builder's): on every answer, so a reload keeps the Test banner. */
    test?: boolean;
    /** `waiting_decision`: the visitor will get a link when the next page is ready. */
    notify?: boolean;
}

/** The page's phase. Loose on purpose: each phase uses its own subset. */
export interface PageState {
    status: string;
    form: SessionPayload['form'] | null;
    csrf: string | null;
    issuedAt: number;
    ending: SessionPayload['ending'] | null;
    theme?: Record<string, unknown> | null;
    progress?: string[] | null;
    progressNote?: string | null;
    typicalSeconds?: number | null;
    /** The journey is a test (sticky once a poll said so). */
    test?: boolean;
    /** `waiting_decision`: whether the visitor will be sent the link. */
    notify?: boolean;
}

type SetState = (update: (s: PageState) => PageState) => void;
type SetSession = (sid: string | null, opts?: { keepUrl?: boolean }) => void;

/** GET the session. `null` means "gone" (404/network); the caller decides. */
export async function fetchSession(token: string | null, sid: string): Promise<SessionPayload | null> {
    try {
        const r = await fetch(`${FORM_API}/${encodeURIComponent(String(token))}/s/${encodeURIComponent(sid)}`, {
            headers: { Accept: 'application/json' },
        });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 1;

/**
 * What a `working` answer changes on the page, or null when it changes nothing.
 * Absent progress leaves the last-known trail up rather than blanking it, and
 * an absent typicalSeconds keeps the last known one: the server leaves it out
 * on a hiccup, and the length of the wait has not changed because of that.
 */
export function workingPatch(payload: SessionPayload | null | undefined): Partial<PageState> | null {
    if (!payload) return null;
    const patch: Partial<PageState> = {};
    if (payload.progress?.length) {
        patch.progress = payload.progress;
        patch.progressNote = payload.progressNote || null;
    }
    if (isSeconds(payload.typicalSeconds)) patch.typicalSeconds = payload.typicalSeconds;
    return Object.keys(patch).length ? patch : null;
}

/**
 * Map a poll response onto the page's phase (form, waiting_decision, done,
 * expired, working, else error).
 *
 * Every branch replaces the whole state, so `theme` is threaded through each
 * one deliberately: it is the one field that belongs to the JOURNEY rather than
 * to the screen, and losing it mid-way makes the next page a different-looking
 * product than the one before it. The same replacement drops `typicalSeconds`
 * on every phase but `working`: it describes a wait, not a journey.
 */
export function applySessionState(payload: SessionPayload, update: SetState, setSession: SetSession): void {
    // A test journey stays one: every phase below replaces the state, and the
    // Test banner must survive all of them (a reload with ?s= never reads
    // GET /form/:token, so the poll is the only one who says so).
    const setState: SetState = (fn) => update(s => {
        const next = fn(s);
        return payload.test === true || s.test === true ? { ...next, test: true } : next;
    });
    switch (payload.state) {
        case 'form':
            setState(s => ({
                status: 'form', form: payload.form ?? null, csrf: payload.csrf ?? null,
                issuedAt: payload.issuedAt || Date.now(), ending: null,
                theme: payload.form?.theme || s.theme || null,
            }));
            break;
        case 'done':
            // The journey is over, so nothing polls or posts to it any more,
            // but `?s=` stays: a reload shows this result again instead of
            // losing it (BFSF-419). "Start again" is the way to a fresh journey.
            setSession(null, { keepUrl: true });
            setState(s => ({
                status: 'done', form: null, csrf: null, issuedAt: 0,
                ending: payload.ending || null, theme: payload.ending?.theme || s.theme || null,
            }));
            break;
        case 'expired':
            setSession(null);
            setState(s => ({ status: 'expired', form: null, csrf: null, issuedAt: 0, ending: null, theme: s.theme || null }));
            break;
        case 'waiting_decision':
            // A person has to decide before the next page exists, which can take
            // days. Polling stops here (the poll loop only runs while 'working')
            // without the "taking a while" error; the session and ?s= stay, so
            // revisiting the link (or "Check again") picks the journey up again.
            setState(s => ({
                status: 'waiting_decision', form: null, csrf: null, issuedAt: 0, ending: null,
                theme: s.theme || null, notify: payload.notify === true,
            }));
            break;
        case 'working':
            // Keep the trail the poll sent. Dropping it meant a page opened (or
            // reloaded) mid-run showed a bare spinner until the NEXT tick.
            setState(s => ({ ...s, status: 'working', ...workingPatch(payload) }));
            break;
        default:
            setSession(null);
            setState(s => ({ status: 'error', form: null, csrf: null, issuedAt: 0, ending: null, theme: s.theme || null }));
    }
}

const SESSION_RE = /^[a-f0-9]{24,64}$/;

export function readSessionFromUrl(): string | null {
    try {
        const sid = new URLSearchParams(window.location.search).get('s');
        return sid && SESSION_RE.test(sid) ? sid : null;
    } catch {
        return null;
    }
}

/** Mirror the session into the URL so a reload resumes rather than restarts. */
export function writeSessionToUrl(sid: string | null): void {
    try {
        const url = new URL(window.location.href);
        if (sid) url.searchParams.set('s', sid);
        else url.searchParams.delete('s');
        window.history.replaceState(null, '', url.toString());
    } catch (err) { logger.debug('a browser without history API still works, just not on reload', err); }
}

export function randomNonce(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        return `n${Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')}`;
    }
    return `n${Date.now().toString(36)}${(performance.now() * 1000).toString(36).replace('.', '')}`;
}
