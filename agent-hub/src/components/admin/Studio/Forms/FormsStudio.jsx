import { AlertCircle, BarChart3, Check, ClipboardList, Link2, Loader2, Plus, RefreshCw, Workflow } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import FormPage from './FormPage';
import NewFormDialog from './NewFormDialog';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../hooks/useTranslation';
import EmptyState from '../../../shared/EmptyState';
import { kindColorVar, kindTint } from '../../../shared/kindColors';
import { toast } from '../../../shared/Toast';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * Studio → Forms — the directory of every form published in the organisation
 * (Track H2, Studio Nav artboard: "Formulieren", last row of Bouwen).
 *
 * A DIRECTORY, WITH A FORM PAGE BEHIND EACH ROW. A form is still not an
 * object of its own in this product: what a visitor fills in is declared on a
 * routine's TRIGGER (`trigger.kind === 'form'`, `trigger.form`); the pages
 * after page one are `form_page` STEPS in that same routine; and the public
 * ADDRESS is a row in `automation_form_pages` that the server mints whenever
 * such a trigger is saved (routes/automation/crud.js's `ensureFormPages`).
 * What a row opens is the FORM PAGE (FormPage.jsx — Questions · Share ·
 * Answers · Settings), addressed by the ROUTINE's id; the trigger's form is
 * edited there without the builder, and "Open the routine" stays for the
 * rest. "New form" is the section's own dialog (NewFormDialog.jsx): a name and
 * whether the answers are collected in a table.
 *
 * NOT /app/forms. `pages/forms/FormsHomePage.jsx` is the same list for the
 * person who FILLS a form in: a tile is the form, and everything else is
 * stripped out. This screen is for the person who BUILDS them, so it says the
 * three things only a builder needs — is it actually live, is anything coming
 * in, and which routine is behind it.
 *
 * ── What this screen must never get wrong ────────────────────────────────
 *
 * THE ROW ID IS A CREDENTIAL. `form.id` IS the public URL token — 192 bits,
 * no second factor (stores/automationStore/forms.js). Listing it here is in
 * contract and is the point of the screen: the builder panel stopped showing
 * the link, so this is the only place left to get it (crud.js's docblock).
 * What it must never do is *travel*: the Form page's route carries the
 * AUTOMATION id (`/app/studio/forms/<automationId>`), never the token; no
 * entry in utils/studioRecentSources.js (whose sub-panel navigates to
 * `studio/<segment>/<item.id>`), no graph node, no Blueprint, no export. The
 * copy button puts it on the clipboard because a person asked for it.
 *
 * AN EMPTY LIST AND A FAILED READ ARE DIFFERENT SCREENS. `listOrgForms()`
 * throws on a non-2xx, and `readFormsPayload` throws on a 2xx whose body is
 * not the shape the route promises — so a 403, an outage and a schema change
 * all land on the error banner, never on "No forms yet". The header's count
 * is rendered only from a list that actually arrived.
 *
 * UNKNOWN IS NOT "FINE". `live` is the difference between a link that works
 * and one that answers 404 (formPublic.js's loadForm 404s a paused or draft
 * routine). A row that does not say gets its own third pill rather than
 * either claim: telling someone their public form is off when it is quietly
 * collecting submissions is the worse half of that guess, and telling them it
 * is live when it is not sends a dead link to a customer.
 *
 * `mine` IS CHECKED FOR TRUE, NOT FOR "NOT FALSE". The list is org-wide but
 * the automation endpoints are still per-user, so only the owner can open the
 * routine behind a form. An absent field is not permission.
 */

/** Escape hatch for the pill styles — three states, one place. */
const STATUS_STYLE = Object.freeze({
    live: { color: 'var(--success)', border: 'var(--success)' },
    off: { color: 'var(--text-tertiary)', border: 'var(--border-subtle)' },
    unknown: { color: 'var(--warning)', border: 'var(--warning)' },
});

/**
 * `'live' | 'off' | 'unknown'` — a THREE-valued read of a two-valued field.
 *
 * The server sends `live: isActive && !isDraft`. If a row ever arrives without
 * it, neither claim is available: "Live" would promise a working link,
 * "Not live" would tell someone a form that may be collecting submissions is
 * switched off. So the absence gets said out loud instead of rounded to
 * whichever answer is more comfortable.
 */
export function formLiveness(form) {
    if (form?.live === true) return 'live';
    if (form?.live === false) return 'off';
    return 'unknown';
}

/**
 * The form's address, or null.
 *
 * NOT A PUBLIC ONE, and this used to say otherwise. `PUBLIC_FORMS_ENABLED` in
 * server/routes/automation/formPublic.js is `false`, and the line under it puts
 * `requireAuth` in front of the whole form surface; `callerMayOpen` then narrows
 * again to the organisation that owns the form. So `/f/<token>` opens for a
 * signed-in colleague in that organisation and for nobody else. Copy that
 * called it public promised a link to a customer that a customer cannot open.
 *
 * `formsAreOrgOnly` below pins that coupling: flip the server flag and the test
 * goes red, so the words on this screen have to be revisited with it.
 *
 * `url` is what the route sends (`/f/<token>`); `/f/<id>` is the same string
 * rebuilt from the id when an older server omitted it. Anything that is not a
 * same-origin absolute path is refused rather than copied: a row is data from
 * the server, and a link that points at another origin is not this
 * organisation's form no matter what the row says.
 */
export function publicFormPath(form) {
    const url = form?.url;
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return url;
    const id = form?.id;
    return typeof id === 'string' && id ? `/f/${id}` : null;
}

/** Whether THIS caller can open the routine behind a form. True, never "not false". */
export function canOpenRoutine(form) {
    return form?.mine === true && typeof form?.automationId === 'string' && !!form.automationId;
}

/**
 * The rows out of a `GET /api/automation/forms` body — or a throw.
 *
 * Deliberately NOT `Array.isArray(body?.forms) ? body.forms : []`. That idiom
 * turns every answer this screen cannot read into an organisation with no
 * forms, which is the one wrong number this directory must never show. A body
 * that is not the promised shape is a failed read and is routed to the error
 * banner with everything else that failed.
 */
export function readFormsPayload(body) {
    if (!body || !Array.isArray(body.forms)) {
        // `unreadable` keeps the technical sentence out of the banner: the
        // screen shows its own translated "could not load" line for this, and
        // reserves the raw message for what the SERVER said (a 403's reason is
        // worth reading; "not { forms: [...] }" is not).
        throw Object.assign(new Error('GET /api/automation/forms did not answer { forms: [...] }'), { unreadable: true });
    }
    return body.forms.filter(Boolean);
}

/** `GET /api/automation/forms/:automationId` → the directory row, or null. */
export function readFormPayload(body) {
    const f = body?.form;
    return f && typeof f === 'object' && typeof f.automationId === 'string' && f.automationId ? f : null;
}

function StatusPill({ form, t }) {
    const state = formLiveness(form);
    const style = STATUS_STYLE[state];
    const label = {
        live: t('forms.status.live', 'Live'),
        off: t('forms.status.off', 'Not live'),
        unknown: t('forms.status.unknown', 'Status unknown'),
    }[state];
    const hint = {
        live: t('forms.status.live_hint', 'Colleagues in your organisation can fill this in after signing in.'),
        off: t('forms.status.off_hint', 'The routine behind it is paused or still a draft, so the link answers “not available”.'),
        unknown: t('forms.status.unknown_hint', 'This row did not say whether the form is live. Open the routine to check.'),
    }[state];
    return (
        <span
            className="inline-flex items-center gap-1 shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border"
            style={{ color: style.color, borderColor: style.border }}
            title={hint}
            data-testid="form-status"
            data-status={state}
        >
            {label}
        </span>
    );
}

function CopyLinkButton({ form, t, onError }) {
    const [copied, setCopied] = useState(false);
    const path = publicFormPath(form);
    if (!path) return null;
    const copy = async () => {
        // The absolute address, not the `/f/<token>` path the API sends: this
        // link is pasted into an e-mail or a website, where a bare path means
        // nothing.
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        try {
            await navigator.clipboard.writeText(`${origin}${path}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            onError({ text: t('forms.studio.copy_failed', 'Could not copy the link — your browser refused clipboard access.'), retry: false });
        }
    };
    return (
        <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            data-testid="form-copy-link"
        >
            {copied ? <Check className="w-3 h-3" style={{ color: 'var(--success)' }} /> : <Link2 className="w-3 h-3" />}
            {copied ? t('forms.studio.copied', 'Link copied') : t('forms.studio.copy_link', 'Copy the link')}
        </button>
    );
}

/** Whether THIS caller may open the Form page: the owner, or a reader of its answers table. */
export function canOpenForm(form) {
    return canOpenRoutine(form) || (!!form?.answers?.grade && typeof form?.automationId === 'string' && !!form.automationId);
}

/** The owner's one-glance answer to "who can fill this in": the whole organisation, n people and groups, or nobody yet. */
function audienceChip(t, audience) {
    if (audience?.mode !== 'restricted') return t('forms.studio.audience_org', 'Everyone in the organisation');
    const n = (Array.isArray(audience.groups) ? audience.groups.length : 0) + (Array.isArray(audience.users) ? audience.users.length : 0);
    if (!n) return t('forms.studio.audience_nobody', 'Only you — not shared yet');
    return nOf(t, 'forms.studio.audience_restricted', n, 'Shared with {count} person or group', 'Shared with {count} people and groups');
}

function FormRow({ form, onNavigate, onOpen, onError }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const mine = canOpenRoutine(form);
    const openable = canOpenForm(form);
    const answers = form?.answers || null;
    const submissions = typeof form?.submissions === 'number' && Number.isFinite(form.submissions)
        ? form.submissions
        : null;
    const last = form?.lastSeenAt ? rel(form.lastSeenAt) : '';

    return (
        <li
            className="rounded-xl border p-3.5"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
            data-testid="form-row"
        >
            <div className="flex items-start gap-2.5">
                <span
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0"
                    style={{ background: kindTint('form', 18), color: kindColorVar('form') }}
                >
                    <ClipboardList className="w-4 h-4" aria-hidden="true" />
                </span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        {openable ? (
                            <button
                                type="button"
                                onClick={() => onOpen && onOpen(form.automationId, null)}
                                className="text-sm font-semibold truncate text-left hover:underline underline-offset-2"
                                style={{ color: 'var(--text-primary)' }}
                                aria-label={t('forms.studio.open_named', 'Open {title}', { title: form?.title || t('forms.studio.untitled', 'Untitled form') })}
                                data-testid="form-open"
                            >
                                {form?.title || t('forms.studio.untitled', 'Untitled form')}
                            </button>
                        ) : (
                            <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                {form?.title || t('forms.studio.untitled', 'Untitled form')}
                            </span>
                        )}
                        <StatusPill form={form} t={t} />
                        {answers?.collecting && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full border shrink-0" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-subtle)' }} data-testid="form-collects">
                                {t('forms.studio.collects_chip', 'collects answers')}
                            </span>
                        )}
                        {mine && form?.audience && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full border shrink-0" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-subtle)' }} data-testid="form-audience-chip">
                                {audienceChip(t, form.audience)}
                            </span>
                        )}
                    </div>
                    {form?.description ? (
                        <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                            {form.description}
                        </div>
                    ) : null}
                    <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }} data-testid="form-meta">
                        {/* Absent, not zero, when the row carries no number —
                            the same rule the rail's counts follow. */}
                        {submissions === null
                            ? null
                            : nOf(t, 'forms.studio.submissions', submissions, '{count} submission', '{count} submissions')}
                        {submissions !== null && last ? ' · ' : null}
                        {last ? t('forms.studio.last_submission', 'last {when}', { when: last }) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                        <CopyLinkButton form={form} t={t} onError={onError} />
                        {answers?.grade && (
                            <button
                                type="button"
                                onClick={() => onOpen && onOpen(form.automationId, 'answers')}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                data-testid="form-answers"
                            >
                                <BarChart3 className="w-3 h-3" aria-hidden="true" />
                                {typeof answers.rowCount === 'number'
                                    ? nOf(t, 'forms.studio.answers_btn', answers.rowCount, 'Answers · {count} response', 'Answers · {count} responses')
                                    : t('forms.page.tab_answers', 'Answers')}
                            </button>
                        )}
                        {mine ? (
                            <button
                                type="button"
                                onClick={() => onNavigate && onNavigate(`studio/automations/${form.automationId}`)}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                data-testid="form-open-routine"
                            >
                                <Workflow className="w-3 h-3" />
                                {t('forms.studio.open_routine', 'Open the routine')}
                            </button>
                        ) : (
                            /* NOT a disabled button: there is nothing to enable.
                               /api/automation/:id is scoped to its owner, so the
                               door does not exist for this caller and saying so
                               beats a control that 403s. */
                            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="form-not-mine">
                                {t('forms.studio.not_yours', 'Built by a colleague — only they can open the routine behind it')}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </li>
    );
}

/**
 * The three mutually exclusive bodies, in the order they can occur:
 * spinner while nothing has arrived, the empty placard, the rows.
 *
 * `forms` is null until a list arrives, so a first read that FAILED renders
 * nothing here at all — the error banner above is then the whole answer, and
 * "No forms yet" is never shown over a list nobody could read.
 */
function FormsBody({ t, forms, loading, isEmpty, onNavigate, onOpen, onError }) {
    const loaded = Array.isArray(forms);
    if (loading && !loaded) {
        return (
            <div
                className="flex items-center justify-center py-12"
                style={{ color: 'var(--text-tertiary)' }}
                role="status"
                aria-label={t('forms.studio.loading', 'Loading forms…')}
                data-testid="forms-loading"
            >
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            </div>
        );
    }
    if (isEmpty) {
        return (
            <EmptyState
                icon={<ClipboardList className="w-10 h-10" />}
                title={t('forms.studio.empty_title', 'No forms yet')}
                description={t('forms.studio.empty_body', 'A form is a page the colleagues you share it with can fill in. Create one and it appears here.')}
            />
        );
    }
    if (!loaded) return null;
    return (
        <ul className="flex flex-col gap-2 list-none p-0 m-0" data-testid="forms-list">
            {forms.map((form, i) => (
                /* Keyed by the token when there is one — it is a primary key —
                   and by position otherwise, so a malformed row still renders
                   instead of being dropped out of the count. */
                <FormRow key={form?.id || `row-${i}`} form={form} onNavigate={onNavigate} onOpen={onOpen} onError={onError} />
            ))}
        </ul>
    );
}

/**
 * Title, count, refresh, "New form".
 *
 * `count` is a NUMBER or null, and null renders nothing at all. The caller
 * passes null both before the first list arrives and after any read fails, so
 * this row can never say "0 forms" about an organisation whose forms it could
 * not read.
 */
function FormsHeader({ t, count, loading, creating, onRefresh, onCreate }) {
    return (
        <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                    <ClipboardList className="w-4 h-4" style={{ color: kindColorVar('form') }} aria-hidden="true" />
                    {t('sidebar.forms', 'Forms')}
                    {typeof count === 'number' && (
                        <span className="text-xs font-normal" style={{ color: 'var(--text-tertiary)' }} data-testid="forms-count">
                            {nOf(t, 'forms.studio.count', count, '{count} form', '{count} forms')}
                        </span>
                    )}
                </h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('forms.studio.intro', 'A form is the front of a routine: whoever fills it in starts it. A published form has an address anyone in your organisation can open once signed in, so it belongs to the organisation rather than to one person.')}
                </p>
            </div>
            {/* Refresh, not a poll. A form appears here the moment a colleague
                saves a form trigger, and this screen is exactly where someone
                stands while waiting for that — but it is also the one control
                through which a read can fail AFTER one succeeded, which is the
                state the count rule above is written for. */}
            <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                title={t('forms.studio.refresh', 'Refresh the list')}
                aria-label={t('forms.studio.refresh', 'Refresh the list')}
                className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                data-testid="forms-refresh"
            >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
            <button
                type="button"
                onClick={onCreate}
                disabled={creating}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                data-testid="forms-new"
            >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {t('forms.studio.new', 'New form')}
            </button>
        </div>
    );
}

export default function FormsStudio({ user = null, onNavigate = null, initialFormId = null, initialFormTab = null }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    // The open form (a routine id), or 'new' for the dialog — adopted from
    // the URL the way DatatablesStudio adopts its id, and written back to it.
    const [openId, setOpenId] = useState(initialFormId || null);
    const [openTab, setOpenTab] = useState(initialFormTab || null);
    const lastInitial = React.useRef(`${initialFormId || ''}|${initialFormTab || ''}`);
    useEffect(() => {
        const key = `${initialFormId || ''}|${initialFormTab || ''}`;
        if (key !== lastInitial.current) {
            lastInitial.current = key;
            setOpenId(initialFormId || null);
            setOpenTab(initialFormTab || null);
        }
    }, [initialFormId, initialFormTab]);
    const open = useCallback((id, tab = null) => {
        setOpenId(id);
        setOpenTab(tab);
        if (onNavigate) onNavigate(id ? `studio/forms/${id}${tab ? `/${tab}` : ''}` : 'studio/forms');
    }, [onNavigate]);
    // THREE states, never folded into two: `forms` is null until a list has
    // actually arrived, so "loaded and empty" (`[]`) can be told apart from
    // "never loaded" — and the header count is rendered from the first only.
    const [forms, setForms] = useState(null);
    const [loading, setLoading] = useState(true);
    // `null` or `{ text, retry }`. `retry` is false for a failure that
    // re-reading cannot fix — a refused CREATE is not a stale list, and
    // offering "Try again" there would reload the list and clear a message
    // about something else entirely.
    const [error, setError] = useState(null);
    const creating = false;

    // `api` is memoised by useAutomationApi (its docblock is about exactly
    // this): an unstable one would make this effect refetch on every render.
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setForms(readFormsPayload(await api.listOrgForms()));
        } catch (err) {
            // The list is NOT cleared. Whatever last arrived is still true as
            // far as anyone knows; blanking it would replace a stale answer
            // with a wrong one, under a banner saying the read failed. The
            // COUNT does go, because that is a claim about the whole
            // organisation and this app no longer knows the whole of it.
            const said = err?.unreadable ? null : err?.message;
            setError({
                text: said || t('forms.studio.load_failed', 'Could not load the forms — this is not an empty list.'),
                retry: true,
            });
        } finally {
            setLoading(false);
        }
    }, [api, t]);

    useEffect(() => { load(); }, [load]);

    const create = () => open('new');

    const loaded = Array.isArray(forms);
    const isEmpty = loaded && !loading && !error && forms.length === 0;

    // The open form comes from the list when it is there. When it is NOT —
    // it was created a moment ago by the dialog, so it is newer than the
    // list; or the page was reached by a deep link before the list arrived —
    // it is looked up by itself (`GET /forms/:automationId`, org-scoped, the
    // same row shape). Only when the list has loaded without it AND that
    // lookup came back empty is the form declared unavailable.
    const listed = loaded && openId && openId !== 'new' ? forms.find(f => f?.automationId === openId) || null : null;
    const [fetched, setFetched] = useState(null); // { id, form|null }
    useEffect(() => {
        if (!openId || openId === 'new' || listed || fetched?.id === openId) return undefined;
        let alive = true;
        (async () => {
            let form = null;
            try { form = readFormPayload(await api.getForm(openId)); } catch { form = null; }
            if (alive) setFetched({ id: openId, form });
        })();
        return () => { alive = false; };
    }, [openId, listed, fetched, api]);
    const openForm = listed || (fetched?.id === openId ? fetched.form : null);
    const settled = !!listed || (loaded && fetched?.id === openId);
    useEffect(() => {
        if (!openId || openId === 'new' || !settled) return;
        if (!openForm || !canOpenForm(openForm)) {
            toast.error(t('forms.page.not_found', 'This form is not available to this account.'));
            open(null);
        }
    }, [openId, settled, openForm, open, t]);

    if (openId && openId !== 'new' && openForm && canOpenForm(openForm)) {
        return (
            <FormPage
                form={openForm}
                tab={openTab}
                onTab={(tab) => { setOpenTab(tab); if (onNavigate) onNavigate(`studio/forms/${openId}/${tab}`); }}
                onBack={() => { open(null); load(); }}
                onNavigate={onNavigate}
                user={user}
                onChanged={load}
            />
        );
    }
    if (openId && openId !== 'new' && !settled) {
        return (
            <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }} role="status" data-testid="forms-loading">
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto custom-scrollbar" style={{ background: 'var(--bg-primary)' }}>
            <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
                <FormsHeader
                    t={t}
                    /* `null`, not a number, whenever the list did not arrive or
                       the last read failed — see FormsHeader. */
                    count={loaded && !error ? forms.length : null}
                    loading={loading}
                    creating={creating}
                    onRefresh={load}
                    onCreate={create}
                />

                {error && (
                    <div
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                        style={{ background: 'color-mix(in srgb, var(--error) 12%, transparent)', color: 'var(--error)' }}
                        role="alert"
                        data-testid="forms-error"
                    >
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        <span className="flex-1 min-w-0">{error.text}</span>
                        {error.retry && (
                            <button type="button" onClick={load} className="underline font-medium shrink-0" data-testid="forms-retry">
                                {t('forms.studio.retry', 'Try again')}
                            </button>
                        )}
                    </div>
                )}

                <FormsBody
                    t={t}
                    forms={forms}
                    loading={loading}
                    isEmpty={isEmpty}
                    onNavigate={onNavigate}
                    onOpen={open}
                    onError={setError}
                />
            </div>
            {openId === 'new' && <NewFormDialog user={user} onClose={() => open(null)} onNavigate={onNavigate} />}
        </div>
    );
}
