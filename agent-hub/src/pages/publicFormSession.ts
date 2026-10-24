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
 * Map a poll response onto the page's phase.
 *
 * Every branch replaces the whole state, so `theme` is threaded through each
 * one deliberately: it is the one field that belongs to the JOURNEY rather than
 * to the screen, and losing it mid-way makes the next page a different-looking
 * product than the one before it. The same replacement drops `typicalSeconds`
 * on every phase but `working`: it describes a wait, not a journey.
 */
export function applySessionState(payload: SessionPayload, setState: SetState, setSession: SetSession): void {
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
