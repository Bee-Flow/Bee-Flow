/**
 * Filling a form in — the journey of the web's PublicFormPage.jsx, natively.
 *
 * Page one is loaded (or a journey already under way is picked up by its
 * session id), the answers are sent, and while the routine works the session
 * is polled until it pauses for another page, ends, or fails. The phases are
 * model/fillSession.ts; this hook only runs the effects that move between
 * them, and hands the screen the calls a page needs: send, upload a file,
 * search an app, and hand over what the routine produced.
 */

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { ApiError } from '@/core/api/client';

import {
    getFillForm,
    getFillSession,
    openFileInNotebooks,
    saveEndingToNotebook,
    searchPickRecords,
    shareFillFile,
    submitFillPage,
    uploadFillFile,
} from '../api/fill';
import { answersBody } from '../model/contract';
import { applySession, checkAgain, failedToStart, INITIAL_FILL, resuming, slowed, started, submitted, type FillState } from '../model/fillSession';
import type { Answers, FillField, FillUploadFile, PickResults, UploadedFile } from '../model/fillTypes';
import { newNonce, nextPollDelay, POLL_CEILING_MS, POLL_MIN_MS, SESSION_RE, submitDelay } from '../model/fillValues';

type SetFill = Dispatch<SetStateAction<FillState>>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A 404 (or any other answer) is "not available"; no answer at all is "could not reach the server". */
const startFailure = (err: unknown): 'missing' | 'offline' => (err instanceof ApiError && typeof err.status === 'number' ? 'missing' : 'offline');

/** Page one — or, with a session to resume, wherever that journey is. */
function useFillLoad(token: string, resumeSid: string | null, setState: SetFill) {
    const resume = useRef(resumeSid && SESSION_RE.test(resumeSid) ? resumeSid : null);
    useEffect(() => {
        let alive = true;
        void (async () => {
            const sid = resume.current;
            if (sid) {
                const session = await getFillSession(token, sid);
                if (!alive) return;
                if (session) {
                    setState((s) => applySession(resuming(s, sid), session, Date.now()));
                    return;
                }
            }
            try {
                const start = await getFillForm(token);
                if (alive) setState((s) => started(s, start, Date.now()));
            } catch (err) {
                if (alive) setState((s) => failedToStart(s, startFailure(err)));
            }
        })();
        return () => {
            alive = false;
        };
    }, [token, setState]);
}

/** While the routine works: poll, easing off, until it answers something other than "working". */
function useFillPoll(token: string, state: FillState, setState: SetFill) {
    const { status, sessionId } = state;
    useEffect(() => {
        if (status !== 'working' || !sessionId) return undefined;
        let alive = true;
        let delay = POLL_MIN_MS;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const startedAt = Date.now();
        const tick = async () => {
            if (!alive) return;
            if (Date.now() - startedAt > POLL_CEILING_MS) {
                setState(slowed);
                return;
            }
            const next = await getFillSession(token, sessionId);
            if (!alive) return;
            // A dropped poll is not fatal: the routine keeps going either way.
            if (next) setState((s) => applySession(s, next, Date.now()));
            if (next && next.state !== 'working') return;
            delay = nextPollDelay(delay);
            timer = setTimeout(() => void tick(), delay);
        };
        timer = setTimeout(() => void tick(), POLL_MIN_MS);
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [status, sessionId, token, setState]);
}

export interface FormFill {
    state: FillState;
    /** Send the page's answers; throws an ApiError whose body may carry `fields`. */
    submit: (fields: readonly FillField[], values: Answers) => Promise<void>;
    upload: (field: FillField, file: FillUploadFile, onProgress?: (fraction: number) => void) => Promise<UploadedFile>;
    searchApp: (field: FillField, query: string) => Promise<PickResults>;
    shareFile: (field: FillField) => Promise<void>;
    openInNotebooks: (field: FillField) => Promise<string | null>;
    saveToNotebook: () => Promise<string | null>;
    checkAgain: () => void;
}

export function useFormFill(token: string, resumeSid: string | null = null): FormFill {
    const [state, setState] = useState<FillState>(INITIAL_FILL);
    useFillLoad(token, resumeSid, setState);
    useFillPoll(token, state, setState);
    // One nonce per rendered page: a double tap is "already got that", a new page mints a new one.
    const nonce = useMemo(() => (state.page ? newNonce() : ''), [state.page]);
    const fileSid = state.fileSessionId ?? '';
    return {
        state,
        submit: async (fields, values) => {
            const wait = submitDelay(state.receivedAt, Date.now());
            if (wait) await sleep(wait);
            const body = { ...answersBody(fields, values), csrf: state.csrf, issuedAt: state.issuedAt, nonce };
            const ack = await submitFillPage(token, state.sessionId, body);
            setState((s) => submitted(s, ack));
        },
        upload: (field, file, onProgress) =>
            uploadFillFile({ token, field: field.name, csrf: state.csrf, sessionId: state.sessionId, maxSizeMb: field.maxSizeMb }, file, onProgress),
        searchApp: (field, query) => searchPickRecords(token, { field: field.name, query, csrf: state.csrf, sessionId: state.sessionId }),
        shareFile: (field) => shareFillFile(token, fileSid, field),
        openInNotebooks: (field) => openFileInNotebooks(token, fileSid, field.fileId),
        saveToNotebook: () => saveEndingToNotebook(token, fileSid, state.ending?.description ?? '', state.ending?.title ?? ''),
        checkAgain: () => setState(checkAgain),
    };
}
