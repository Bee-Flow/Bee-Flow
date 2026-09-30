/**
 * The filling screen's journey, as a pure state machine — the web's
 * PublicFormPage.jsx phases and its applySessionState:
 *
 *   loading → form → working → form (page N) → done | error | expired
 *
 * plus the dead ends a first load can hit (missing, offline) and `slow`, when
 * the poll gives up waiting and offers "Check again". A single-page form is
 * done the moment its submit is accepted; anything with a later page has to
 * wait for the run, because only the server knows whether the routine paused
 * for another page, ended on a summary, or failed.
 *
 * The theme belongs to the JOURNEY, not to a screen: it is carried through
 * every transition so a light form does not go dark while the routine works.
 */

import type { FillAck, FillForm, FillSession, FillStart } from './fillTypes';

export type FillStatus = 'loading' | 'form' | 'working' | 'slow' | 'done' | 'missing' | 'expired' | 'offline' | 'error';

export interface FillState {
    status: FillStatus;
    form: FillForm | null;
    csrf: string;
    /** The server's clock when it handed the page out (sent back with the answers). */
    issuedAt: number;
    /** This device's clock when the page arrived — what the two-second wait counts from. */
    receivedAt: number;
    ending: FillForm | null;
    theme: Record<string, unknown> | null;
    progress: string[];
    progressNote: string | null;
    /** The journey's session, while there is one to follow. */
    sessionId: string | null;
    /** The session files are fetched through — kept after `done`, which is where a download lives. */
    fileSessionId: string | null;
    /** Whether page one said the routine may pause for another page. */
    multiPage: boolean;
    /** Which page this is, counting from one; a new page remounts the fields. */
    page: number;
}

export const INITIAL_FILL: FillState = {
    status: 'loading',
    form: null,
    csrf: '',
    issuedAt: 0,
    receivedAt: 0,
    ending: null,
    theme: null,
    progress: [],
    progressNote: null,
    sessionId: null,
    fileSessionId: null,
    multiPage: false,
    page: 0,
};

/** Page one arrived. */
export function started(state: FillState, start: FillStart, now: number): FillState {
    return {
        ...state,
        status: 'form',
        form: start.form,
        csrf: start.csrf,
        issuedAt: start.issuedAt || now,
        receivedAt: now,
        ending: null,
        theme: start.form.theme ?? state.theme,
        multiPage: start.form.multiPage,
        page: state.page + 1,
    };
}

/** Page one could not be had: `missing` for a 404 (any 404 — unknown, closed and not-yours look alike). */
export function failedToStart(state: FillState, reason: 'missing' | 'offline'): FillState {
    return { ...state, status: reason };
}

/** The single-page ending: the success message, in the form's own theme. */
function successEnding(form: FillForm | null): FillForm | null {
    if (!form) return null;
    return { ...form, title: form.successMessage, description: '', fields: [] };
}

/**
 * The server took a page. A form with no later page is done now. Otherwise
 * the journey waits on its session — and a take that came back without one
 * (a replayed nonce, or the bot check's silent accept) has nothing to follow,
 * so it ends on the thank-you rather than spinning on a session that is not
 * there.
 */
export function submitted(state: FillState, ack: FillAck): FillState {
    const sessionId = ack.sessionId ?? state.sessionId;
    if (!(state.multiPage || state.sessionId) || !sessionId) {
        return { ...state, status: 'done', ending: successEnding(state.form), form: null };
    }
    return {
        ...state,
        status: 'working',
        form: null,
        sessionId,
        fileSessionId: sessionId,
        progress: [],
        progressNote: null,
    };
}

/** A poll's answer, mapped onto the phase (the web's applySessionState). */
export function applySession(state: FillState, session: FillSession, now: number): FillState {
    switch (session.state) {
        case 'form':
            return {
                ...state,
                status: 'form',
                form: session.form,
                csrf: session.csrf,
                issuedAt: session.issuedAt || now,
                receivedAt: now,
                ending: null,
                theme: session.form.theme ?? state.theme,
                page: state.page + 1,
            };
        case 'done':
            // The journey is over: nothing to resume, but files are still fetched through it.
            return { ...state, status: 'done', form: null, sessionId: null, ending: session.ending, theme: session.ending?.theme ?? state.theme };
        case 'expired':
            return { ...state, status: 'expired', form: null, sessionId: null };
        case 'working':
            // Keep the last trail when a tick has none: a bare spinner between steps reads as a hang.
            return session.progress.length
                ? { ...state, status: 'working', progress: session.progress, progressNote: session.progressNote }
                : { ...state, status: 'working' };
        default:
            return { ...state, status: 'error', form: null, sessionId: null };
    }
}

/** A session to pick up (a reopened journey): straight to waiting on it. */
export function resuming(state: FillState, sessionId: string): FillState {
    return { ...state, status: 'working', sessionId, fileSessionId: sessionId, multiPage: true };
}

/** The poll ran past its ceiling: stop and offer to check again. */
export const slowed = (state: FillState): FillState => ({ ...state, status: 'slow' });
export const checkAgain = (state: FillState): FillState => ({ ...state, status: 'working' });
