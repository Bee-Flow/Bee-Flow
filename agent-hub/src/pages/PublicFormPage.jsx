import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import useFormResultActions from './useFormResultActions';
import PublicFormRenderer, { FormEndingView, FormWaitingView } from '../components/forms/PublicFormRenderer';
import useTranslation from '../hooks/useTranslation';

const API = (import.meta.env.VITE_API_URL || '') + '/api/automation/form';

// Poll cadence while the automation works. Starts sub-second so a fast automation
// feels instant, then eases off so a slow one is not hammered.
const POLL_MIN_MS = 700;
const POLL_MAX_MS = 2000;
const POLL_STEP_MS = 200;
// After this the page stops polling and offers a manual retry, rather than
// spinning at someone forever.
const POLL_CEILING_MS = 5 * 60 * 1000;

/**
 * The hosted page behind a form trigger's public URL (`/f/<token>`).
 *
 * Anonymous by design, so three rules apply:
 *
 *   • BARE fetch, never authFetch — authFetch reloads the whole page on any
 *     401, which would put a visitor into a redirect loop on a page that has
 *     no session to begin with.
 *   • It stamps `data-theme` on <html> itself. `:root` in index.css is the DARK
 *     palette; the light values live under `[data-theme="light"]`, which only
 *     applyThemeToDocument sets — and that never runs for an anonymous visitor.
 *     Without this every "light" form would render dark.
 *   • The token is the credential, so an unknown/paused/renamed form is one
 *     indistinguishable "not found" — never a hint that the URL was once real.
 *
 * MULTI-PAGE. An automation can pause at a `form_page` step. The visitor never
 * leaves this URL: submitting returns a session id, the page polls it, and
 * whatever comes back — another page, a closing summary, or a failure — is
 * rendered here. The session id is mirrored into `?s=…` so a reload resumes
 * the journey instead of restarting it at page one.
 *
 * The closing page KEEPS `?s=` (BFSF-419). Its result (a blog post, a summary)
 * often exists nowhere else the visitor can reach, so a reload, the back
 * button or the browser history has to bring it back for as long as the
 * session lives (the server refreshes it on every read). "Start again" is the
 * explicit way to a fresh journey, and the one place that drops `?s=`.
 *
 * `authenticated` says whether the caller already knows this visitor is a
 * signed-in Bee Flow member — today that is always true, because /f/<token>
 * redirects into the workspace (App.jsx) and this page only ever renders
 * inside AgentHub, where `user` is already known. It stays a prop rather than
 * something this component checks itself so the anonymous rules above hold:
 * no authFetch, no whoami round trip that could 401. It gates the closing
 * page's server-side result actions (Word/PDF, Save to Notebook, Save as
 * Webpage) — they need a signed-in owner — so flipping PUBLIC_FORMS_ENABLED
 * back to a genuinely anonymous visitor degrades those buttons rather than
 * breaking; .txt and Copy keep working.
 *
 * `webpagesEnabled` says whether this workspace has Webpages at all (the same
 * entitlement as the /api/webpages gate); without it "Save as Webpage" is not
 * offered.
 *
 * Phases: loading → form → working → form (page N) → done | error | expired.
 */
export default function PublicFormPage({ token, authenticated = false, webpagesEnabled }) {
    const [state, setState] = useState({ status: 'loading', form: null, csrf: null, issuedAt: 0, ending: null });
    // The session id lives in a ref as well as in state: the poll loop closes
    // over it, and re-creating the loop on every render would restart the timer.
    const sessionRef = useRef(readSessionFromUrl());
    const [sessionId, setSessionId] = useState(sessionRef.current);
    // The session id kept purely for FETCHING FILES, which outlives the one
    // above. `setSession(null)` fires the moment the journey reports `done` —
    // and `done` is exactly the page a download lives on. Sharing one ref meant
    // the closing page built no link at all.
    const fileSidRef = useRef(sessionRef.current);

    const setSession = useCallback((sid, { keepUrl = false } = {}) => {
        sessionRef.current = sid;
        if (sid) fileSidRef.current = sid;
        setSessionId(sid);
        if (!keepUrl) writeSessionToUrl(sid);
    }, []);
    // Bumped by "Start again" to load page one afresh.
    const [restart, setRestart] = useState(0);
    const { t } = useTranslation();

    // ── Page one, or resume an in-flight session after a reload ────────────
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                // A `?s=` in the URL means this browser was already mid-journey.
                // Ask the session first; only fall back to page one if it is
                // gone, so a reload does not silently re-submit the first page.
                if (sessionRef.current) {
                    const resumed = await fetchSession(token, sessionRef.current);
                    if (!alive) return;
                    if (resumed) { applySessionState(resumed, setState, setSession); return; }
                    setSession(null);
                }
                const r = await fetch(`${API}/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } });
                const body = await r.json().catch(() => ({}));
                if (!alive) return;
                if (!r.ok) { setState({ status: 'missing', form: null, csrf: null, issuedAt: 0, ending: null }); return; }
                setState({ status: 'form', form: body.form, csrf: body.csrf, issuedAt: body.issuedAt || Date.now(), ending: null, theme: body.form?.theme || null });
            } catch {
                if (alive) setState({ status: 'offline', form: null, csrf: null, issuedAt: 0, ending: null });
            }
        })();
        return () => { alive = false; };
    }, [token, setSession, restart]);

    // ── Poll while the automation is working ─────────────────────────────────
    useEffect(() => {
        if (state.status !== 'working' || !sessionId) return undefined;
        let alive = true;
        let delay = POLL_MIN_MS;
        let timer = null;
        const startedAt = Date.now();

        const tick = async () => {
            if (!alive) return;
            if (Date.now() - startedAt > POLL_CEILING_MS) {
                setState(s => ({ ...s, status: 'slow' }));
                return;
            }
            const next = await fetchSession(token, sessionId);
            if (!alive) return;
            if (next && next.state !== 'working') { applySessionState(next, setState, setSession); return; }
            // Still working — but the poll also says WHICH step, so the wait
            // has something to show for itself. Absent progress leaves the
            // last-known trail up rather than blanking it between steps.
            if (next?.progress?.length) {
                setState(s => ({ ...s, progress: next.progress, progressNote: next.progressNote || null }));
            }
            // A dropped poll is not fatal — the run keeps going either way.
            delay = Math.min(POLL_MAX_MS, delay + POLL_STEP_MS);
            timer = setTimeout(tick, delay);
        };
        timer = setTimeout(tick, POLL_MIN_MS);
        return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [state.status, sessionId, token, setSession]);

    // The author's theme, remembered.
    //
    // It used to be read off `state.form`, which submit() clears — so the whole
    // waiting stretch, the longest part of a multi-page form, fell back to
    // 'auto' and a light form went dark the moment someone answered a question.
    // Every screen of one journey should look like the same product.
    const theme = state.theme || (state.form || state.ending)?.theme || null;
    const appearance = theme?.appearance || 'auto';
    useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const root = document.documentElement;
        const previous = root.getAttribute('data-theme');
        const resolved = appearance === 'auto'
            ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : appearance;
        root.setAttribute('data-theme', resolved);
        return () => {
            if (previous === null) root.removeAttribute('data-theme');
            else root.setAttribute('data-theme', previous);
        };
    }, [appearance]);

    // Where a `download` field's file lives. Built HERE rather than sent by the
    // server, because the link is scoped to this token + session and the page is
    // the only thing that knows both — and because composing it against `API`
    // keeps it right when the backend sits on another origin.
    const downloadHref = useCallback((field) => {
        // `fileSidRef`, not `sessionRef`: the closing page has already dropped
        // the resume session by the time it renders. The session row itself
        // lives on server-side until it expires, so the link keeps working.
        const sid = fileSidRef.current;
        if (!field?.fileId || !sid) return null;
        return `${API}/${encodeURIComponent(token)}/s/${encodeURIComponent(sid)}/file/${encodeURIComponent(field.fileId)}`;
    }, [token, sessionId]);

    /**
     * "Open in Notebooks" — the server copies the document into a new notebook
     * and answers with its id; we go there.
     *
     * Same token + session scoping as downloadHref, for the same reason: the
     * server will only hand over a file that belongs to THIS visitor's journey.
     * A hard navigation rather than an in-app one, because this component also
     * renders standalone and has no router of its own.
     */
    const openInNotebooks = useCallback(async (field) => {
        const sid = fileSidRef.current;
        if (!field?.fileId || !sid) throw new Error('This document is no longer available.');
        const r = await fetch(
            `${API}/${encodeURIComponent(token)}/s/${encodeURIComponent(sid)}/file/${encodeURIComponent(field.fileId)}/notebook`,
            { method: 'POST', headers: { Accept: 'application/json' } },
        );
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body?.notebookId) throw new Error(body?.error || 'Could not open this in Notebooks.');
        window.location.href = `/app/studio/documents/notebook/${body.notebookId}`;
    }, [token]);

    // The export bar's Word/PDF, Notebook and Webpage actions (BFSF-419).
    // `fileSidRef` for the same reason as downloadHref above.
    const { saveToNotebook, saveAsWebpage, downloadAs } = useFormResultActions({
        api: API, token, sessionRef: fileSidRef, ending: state.ending, authenticated, webpagesEnabled: webpagesEnabled === true,
    });

    const upload = useCallback(async (file, field) => {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('field', field);
        fd.append('csrf', state.csrf || '');
        // A later page's upload is checked against THAT page's declared fields,
        // so the server needs to know which page we are on.
        if (sessionRef.current) fd.append('sessionId', sessionRef.current);
        const r = await fetch(`${API}/${encodeURIComponent(token)}/upload`, { method: 'POST', body: fd });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Upload failed');
        return body;
    }, [token, state.csrf]);

    /**
     * An `app_pick` question's search box.
     *
     * The browser sends a FIELD NAME and a search term — never an app, never a
     * tool. Which app that field means, and whether this person may search it,
     * are both answered on the server from the declaration; a refusal ("not
     * connected for your account") comes back as `error` on a 200, because it is
     * something to print beside the box rather than a failure of the request.
     */
    const searchApp = useCallback(async (field, query) => {
        const r = await fetch(`${API}/${encodeURIComponent(token)}/pick`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                field: field.name,
                query,
                csrf: state.csrf || '',
                // Like the upload call: a later page's search is checked
                // against THAT page's declared fields.
                ...(sessionRef.current ? { sessionId: sessionRef.current } : {}),
            }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'That app could not be searched.');
        return body;
    }, [token, state.csrf]);

    // One nonce per rendered page. A double-click or a refresh-resubmit reuses
    // it and the server answers "already got that" instead of running twice;
    // moving to the next page mints a fresh one (state.csrf changes with it).
    const nonce = useMemo(() => randomNonce(), [token, state.csrf]);

    // Whether this journey has more screens after the current one. A plain
    // one-page form shows its thank-you the moment the submit is accepted and
    // never polls; anything with a form_page step has to wait for the run.
    const multiPage = !!state.form?.multiPage || !!sessionId;

    const submit = useCallback(async (values) => {
        const sid = sessionRef.current;
        const url = sid
            ? `${API}/${encodeURIComponent(token)}/s/${encodeURIComponent(sid)}`
            : `${API}/${encodeURIComponent(token)}`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...values, csrf: state.csrf, issuedAt: state.issuedAt, nonce }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            const err = new Error(body.error || 'Something went wrong. Please try again.');
            err.fields = body.fields;
            throw err;
        }
        // A one-page form is done: the renderer shows its own success card and
        // this resolve is all it needs. Nothing to poll for.
        if (!multiPage) return;
        // The first submission mints the session; later pages keep theirs.
        if (body.sessionId) setSession(body.sessionId);
        // Hand over to the poll loop: only the server knows whether the automation
        // paused for another page or ran to the end.
        setState(s => ({ ...s, status: 'working', form: null, progress: null, progressNote: null }));
    }, [token, state.csrf, state.issuedAt, nonce, setSession, multiPage]);

    const retry = useCallback(() => setState(s => ({ ...s, status: 'working' })), []);

    /** Leave the finished journey for a fresh one: the only place that drops `?s=` after the closing page. */
    const startAgain = useCallback(() => {
        setSession(null);
        fileSidRef.current = null;
        setState(s => ({ status: 'loading', form: null, csrf: null, issuedAt: 0, ending: null, theme: s.theme || null }));
        setRestart(n => n + 1);
    }, [setSession]);

    return (
        <div className="min-h-screen w-full flex items-start justify-center px-4 py-10 sm:py-16 bg-[var(--bg-primary)]">
            <div className="w-full max-w-xl">
                {state.status === 'loading' && (
                    <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--text-secondary)]">
                        <Loader2 size={16} className="animate-spin" /> {t('forms.public_loading', 'Loading…')}
                    </div>
                )}
                {state.status === 'working' && (
                    <>
                        <FormWaitingView theme={theme} progress={state.progress} note={state.progressNote} />
                    </>
                )}
                {state.status === 'slow' && (
                    <div className="text-center py-24">
                        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{t('forms.public_slow_title', 'This is taking a while')}</h1>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('forms.public_slow_text', 'Your answers were received — we are still working on them.')}</p>
                        <button
                            type="button"
                            onClick={retry}
                            className="mt-4 px-3 py-1.5 text-sm rounded-md border border-[var(--border-default)] text-[var(--text-primary)]"
                        >
                            {t('forms.public_check_again', 'Check again')}
                        </button>
                    </div>
                )}
                {state.status === 'missing' && (
                    <div className="text-center py-24">
                        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{t('forms.public_missing_title', 'This form is not available')}</h1>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">
                            {t('forms.public_missing_text', 'The link may have expired, or the form may have been taken offline.')}
                        </p>
                    </div>
                )}
                {state.status === 'expired' && (
                    <div className="text-center py-24">
                        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{t('forms.public_expired_title', 'This form has expired')}</h1>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('forms.public_expired_text', 'It was left open too long. Open the link again to start over.')}</p>
                    </div>
                )}
                {state.status === 'offline' && (
                    <div className="text-center py-24">
                        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{t('forms.public_offline_title', 'Could not reach the server')}</h1>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('forms.public_offline_text', 'Please check your connection and reload the page.')}</p>
                    </div>
                )}
                {state.status === 'error' && (
                    <div className="text-center py-24">
                        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{t('forms.public_error_title', 'Something went wrong')}</h1>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('forms.public_error_text', 'We could not finish this form. Please try again later.')}</p>
                    </div>
                )}
                {state.status === 'done' && (
                    <>
                        <FormEndingView
                            form={state.ending}
                            downloadHref={downloadHref}
                            onOpenInNotebooks={openInNotebooks}
                            onSaveToNotebook={saveToNotebook}
                            onSaveAsWebpage={saveAsWebpage}
                            onDownloadAs={downloadAs}
                        />
                        <div className="mt-4 text-center">
                            <button
                                type="button"
                                onClick={startAgain}
                                data-testid="form-start-again"
                                className="px-3 py-1.5 text-sm rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            >
                                {t('forms.result.start_again', 'Start again')}
                            </button>
                        </div>
                    </>
                )}
                {state.status === 'form' && (
                    <>
                        <PublicFormRenderer
                            // Remount on every page so answers, errors and the
                            // honeypot never bleed from one page into the next.
                            key={`${state.csrf || 'page1'}`}
                            form={state.form}
                            onSubmit={submit}
                            onUpload={upload}
                            onSearchApp={searchApp}
                            downloadHref={downloadHref}
                            onOpenInNotebooks={openInNotebooks}
                            showSuccess={!multiPage}
                        />
                    </>
                )}
            </div>
        </div>
    );
}

/** GET the session. `null` means "gone" (404/network); the caller decides. */
async function fetchSession(token, sid) {
    try {
        const r = await fetch(`${API}/${encodeURIComponent(token)}/s/${encodeURIComponent(sid)}`, {
            headers: { Accept: 'application/json' },
        });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

/**
 * Map a poll response onto the page's phase.
 *
 * Every branch replaces the whole state, so `theme` is threaded through each
 * one deliberately: it is the one field that belongs to the JOURNEY rather than
 * to the screen, and losing it mid-way makes the next page a different-looking
 * product than the one before it.
 */
function applySessionState(payload, setState, setSession) {
    switch (payload.state) {
        case 'form':
            setState(s => ({
                status: 'form', form: payload.form, csrf: payload.csrf,
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
            setState(s => ({
                ...s,
                status: 'working',
                ...(payload.progress?.length ? { progress: payload.progress, progressNote: payload.progressNote || null } : {}),
            }));
            break;
        default:
            setSession(null);
            setState(s => ({ status: 'error', form: null, csrf: null, issuedAt: 0, ending: null, theme: s.theme || null }));
    }
}

const SESSION_RE = /^[a-f0-9]{24,64}$/;

function readSessionFromUrl() {
    try {
        const sid = new URLSearchParams(window.location.search).get('s');
        return sid && SESSION_RE.test(sid) ? sid : null;
    } catch {
        return null;
    }
}

/** Mirror the session into the URL so a reload resumes rather than restarts. */
function writeSessionToUrl(sid) {
    try {
        const url = new URL(window.location.href);
        if (sid) url.searchParams.set('s', sid);
        else url.searchParams.delete('s');
        window.history.replaceState(null, '', url.toString());
    } catch { /* a browser without history API still works, just not on reload */ }
}

function randomNonce() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
