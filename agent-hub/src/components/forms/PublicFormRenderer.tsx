import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Check, Download, BookOpen, Copy, FileText, FileDown, Globe, type LucideIcon } from 'lucide-react';
import { resultFilename, saveBlob } from './resultFile';
import useTranslation from '../../hooks/useTranslation';
import themeVars from '../admin/Studio/AppStudio/runtime/themeVars';
import { messageOf } from '../../utils/caughtError';
import FormField from './fields/FormField';
import { FormRichText } from './fields/FormRichText';
import { collectErrors, fieldError, groupBlocks, initialValues, isDisplayField, submissionValues, typicalDurationText, visibleNames } from './formRules';
import type { FormErrorHandler, FormEndingViewProps, FormExportBarProps, FormFieldDef, FormValue, FormValues, FormWaitingViewProps, PublicFormRendererProps, SubmitError } from './PublicFormRenderer.types';

// The importers reach these through this module.
export { FormRichText, initialValues };

/** The server's per-question messages from a refused submit, by name, or null when it sent none. */
function fieldErrorsOf(err: unknown): Record<string, string> | null {
    const perField = typeof err === 'object' && err !== null && 'fields' in err ? (err as SubmitError).fields : undefined;
    if (!Array.isArray(perField) || !perField.length) return null;
    return Object.fromEntries(perField.map(f => [f.field, f.message]));
}

/**
 * Renders one form-trigger form. Used by the PUBLIC hosted page and by the
 * builder's live preview, so what the author sees while editing is literally
 * the same component the visitor gets.
 *
 * Deliberately NOT App Studio's AppForm: that hangs off useRuntime() (mode,
 * runAction, scope), a node tree and componentRegistry — none of which exist
 * for an anonymous visitor, and componentRegistry pulls in authenticated
 * components. What IS reused directly is themeVars.js and uiBits.jsx (both
 * import nothing but React), so the look stays identical without the coupling.
 *
 * Props:
 *   form      — the server's renderConfig(): { title, description, submitLabel,
 *               successMessage, theme, fields }
 *   onSubmit(values) → Promise; resolves = success, rejects = show the message.
 *               Omitted in preview mode, which makes the form inert.
 *   onUpload(file, field) → Promise<{ fileId, filename, size }>
 *   onSearchApp(field, query) → Promise<{ results, error }> — an `app_pick`
 *               question's search box. The page supplies it because only the
 *               page knows the token, the CSRF and (on a later page) the
 *               session; this component only knows there is a question to
 *               answer. Omitted in preview mode, which leaves the picker
 *               visible but inert — an author looking at their own form should
 *               see the search box, not an empty space where it will be.
 *   preview   — no submission, no network; the author is just looking
 *   showSuccess — whether a resolved submit swaps the form for its
 *               successMessage. TRUE for a single-page form, where this
 *               component owns the ending. FALSE for a multi-page one, where
 *               the automation may still pause for another page and only the page
 *               that is polling knows what comes next.
 */
export default function PublicFormRenderer({ form, onSubmit = null, onUpload = null, onSearchApp = null, preview = false, showSuccess = true, downloadHref = null, onOpenInNotebooks = null }: PublicFormRendererProps) {
    const { t } = useTranslation();
    const fields = useMemo(() => form?.fields || [], [form?.fields]);
    const theme = form?.theme || {};
    const [values, setValues] = useState<FormValues>(() => initialValues(fields));
    const [errors, setErrors] = useState<Record<string, string | null>>({});
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    // The honeypot. Never labelled, never in the tab order, never on screen —
    // only a bot that fills every input it finds will touch it.
    const [honeypot, setHoneypot] = useState('');

    const style = useMemo(() => themeVars(theme), [theme]);
    // Which questions are on screen. A hidden one is not drawn, not checked and
    // not sent; the server decides the same way and re-checks everything.
    const visible = useMemo(() => visibleNames(fields, values), [fields, values]);
    const blocks = useMemo(() => groupBlocks(fields, visible), [fields, visible]);

    // A question that disappears takes its error with it, so it cannot come
    // back from hiding still red.
    useEffect(() => {
        setErrors(prev => {
            const stale = Object.keys(prev).filter(name => prev[name] && !visible.has(name));
            if (!stale.length) return prev;
            const next = { ...prev };
            for (const name of stale) next[name] = null;
            return next;
        });
    }, [visible]);

    const set = (name: string, v: FormValue) => {
        setValues(prev => ({ ...prev, [name]: v }));
        setErrors(prev => (prev[name] ? { ...prev, [name]: null } : prev));
    };

    // On blur only the RULES speak: a visitor tabbing past a required question
    // has not refused to answer it yet. Required is checked on submit.
    const checkRules = (f: FormFieldDef) => {
        const message = fieldError(f, values[f.name], t, { checkRequired: false });
        setErrors(prev => (prev[f.name] === message || (!prev[f.name] && !message) ? prev : { ...prev, [f.name]: message }));
    };

    const submit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (preview || !onSubmit || busy) return;
        // Client-side checks are a courtesy, not a gate — the server re-checks
        // every field against the declaration.
        const found = collectErrors(fields, values, visible, t);
        if (Object.keys(found).length) { setErrors(found); return; }

        setBusy(true);
        setFormError(null);
        try {
            await onSubmit({ ...submissionValues(fields, values, visible), website_url: honeypot });
            if (showSuccess) setDone(true);
        } catch (err) {
            const perField = fieldErrorsOf(err);
            if (perField) setErrors(perField);
            else setFormError(messageOf(err, 'Something went wrong. Please try again.'));
        } finally {
            setBusy(false);
        }
    };

    if (done) return <FormEndingView form={{ ...form, title: form.successMessage, description: '' }} />;

    const renderField = (field: FormFieldDef) => (
        <FormField
            key={field.name}
            field={field}
            value={values[field.name]}
            error={errors[field.name] || null}
            disabled={preview || busy}
            onChange={(v: FormValue) => set(field.name, v)}
            onBlur={() => checkRules(field)}
            onUpload={onUpload}
            onSearchApp={onSearchApp}
            onError={((msg: string) => setErrors(prev => ({ ...prev, [field.name]: msg }))) as FormErrorHandler}
            downloadHref={downloadHref ? downloadHref(field) : null}
            onOpenInNotebooks={onOpenInNotebooks}
        />
    );

    return (
        <form
            style={style}
            onSubmit={submit}
            noValidate
            className="w-full flex flex-col"
        >
            <div
                className="border px-6 py-6 flex flex-col gap-5"
                style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-card, var(--bg-secondary))' }}
            >
                <header className="flex flex-col gap-1.5">
                    <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{form.title}</h1>
                    {form.description ? (
                        <FormRichText className="text-sm" style={{ color: 'var(--text-secondary)' }}>{form.description}</FormRichText>
                    ) : null}
                </header>

                {blocks.map(block => (block.kind === 'group' ? (
                    // One question per list item: the header names the list, the
                    // items sit under it as ordinary questions.
                    <div
                        key={`group_${block.group}`}
                        role="group"
                        aria-labelledby={block.header?.label ? `ff_${block.header.name}` : undefined}
                        className="flex flex-col gap-4 pl-4 border-l-2 border-[var(--border-default)]"
                        data-testid={`form-group-${block.group}`}
                    >
                        {block.header ? renderField(block.header) : null}
                        {block.items.map(renderField)}
                    </div>
                ) : renderField(block.field)))}

                {/* Honeypot — hidden from people AND from assistive tech, so
                    only an indiscriminate bot fills it in. */}
                <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
                    <label htmlFor="website_url">{t('forms.honeypot_label', 'Leave this field empty')}</label>
                    <input id="website_url" name="website_url" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHoneypot(e.target.value)} />
                </div>

                {formError ? (
                    <p className="text-sm" role="alert" style={{ color: '#ef4444' }}>{formError}</p>
                ) : null}

                <button
                    type="submit"
                    disabled={preview || busy}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium disabled:opacity-60"
                    style={{ background: 'var(--app-primary)', color: 'var(--app-primary-contrast)', borderRadius: 'var(--app-radius)' }}
                >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : null}
                    {form.submitLabel}
                </button>
            </div>
        </form>
    );
}

/** How long this form's runs usually take, when the poll knew; nothing otherwise. */
function TypicalDuration({ seconds }: { seconds: number | null | undefined }) {
    const { t } = useTranslation();
    const text = typicalDurationText(seconds, t);
    return text ? <span className="text-xs text-[var(--text-tertiary)]" data-testid="form-waiting-typical">{text}</span> : null;
}

/**
 * The screen a visitor sits on while the automation works.
 *
 * A multi-page form pauses the run at every question, and the stretch between
 * two questions is whatever the author put there — a web search, a model call,
 * a document being written. That is regularly a minute or more, and a bare
 * spinner over an empty page reads as "this broke".
 *
 * So it says WHERE the automation is. `progress` is the trail the poll sends:
 * titles only, outermost flowlet first, the node it is on last. The last
 * segment is the headline because that is the thing actually happening; the
 * flowlets above it are context and sit in the eyebrow.
 *
 * `note` is the running flowlet's own one-line description, when its author
 * gave it one. A name says where the automation is; the description says what it
 * is doing — "Searches Google for a given term and lets AI analyse top-ranking
 * pages…" is the difference between a wait that reads as progress and one that
 * reads as a hang. It takes the place of the generic reassurance line, which
 * steps back to a quieter tone rather than disappearing: it is the line that
 * says the length of the wait is expected.
 *
 * Themed like the form and the closing page — one card on the page's ground —
 * because a full-bleed dark page with two lines of grey text on it is not a
 * design, it is an absence of one.
 */
export function FormWaitingView({ theme = null, progress = null, note = null, label = 'Working on it', typicalSeconds = null }: FormWaitingViewProps) {
    const style = useMemo(() => themeVars(theme || {}), [theme]);
    const trail = Array.isArray(progress) ? progress.filter(Boolean) : [];
    const current = trail.length ? trail[trail.length - 1] : null;
    const context = trail.slice(0, -1);
    const summary = typeof note === 'string' && note.trim() ? note.trim() : null;

    return (
        <div style={style} className="w-full" data-testid="form-waiting" role="status" aria-live="polite">
            <style>{WAITING_KEYFRAMES}</style>
            <div
                className="flex flex-col gap-4 px-6 py-8 border"
                style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-card, var(--bg-secondary))' }}
            >
                <div className="flex items-start gap-4">
                    {/* A ring rather than a bare spinner: it reads as a process
                        that is running, not as a page that failed to load. */}
                    <span
                        aria-hidden="true"
                        className="flex-shrink-0 mt-0.5"
                        style={{
                            width: 34, height: 34, borderRadius: '999px',
                            border: '2px solid var(--app-primary-soft)',
                            borderTopColor: 'var(--app-primary)',
                            animation: 'bf-form-spin 900ms linear infinite',
                        }}
                    />
                    <div className="min-w-0 flex flex-col gap-1">
                        {context.length ? (
                            <span
                                className="text-[11px] font-medium uppercase tracking-wide truncate text-[var(--app-primary)]"
                                title={context.join(' › ')}
                            >
                                {context.join(' › ')}
                            </span>
                        ) : null}
                        <span className="text-base font-semibold leading-snug text-[var(--text-primary)]">
                            {current || `${label}…`}
                        </span>
                        {summary ? (
                            <span
                                className="text-xs leading-relaxed text-[var(--text-secondary)]"
                                data-testid="form-waiting-note"
                            >
                                {summary}
                            </span>
                        ) : null}
                        <span className="text-xs" style={{ color: summary ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
                            {current ? `${label} — this can take a moment.` : 'This can take a moment.'}
                        </span>
                        {/* How long this form's runs usually take, when the poll knew:
                            a wait with a number on it reads as progress, not as a hang. */}
                        <TypicalDuration seconds={typicalSeconds} />
                    </div>
                </div>

                {/* Indeterminate on purpose. The automation cannot say how far
                    along it is — a percentage here would be a lie. */}
                <span
                    aria-hidden="true"
                    className="block w-full overflow-hidden"
                    style={{ height: 3, borderRadius: 999, background: 'var(--app-primary-soft)' }}
                >
                    <span
                        className="block h-full"
                        style={{
                            width: '38%', borderRadius: 999, background: 'var(--app-primary)',
                            animation: 'bf-form-sweep 1.6s ease-in-out infinite',
                        }}
                    />
                </span>
            </div>
        </div>
    );
}

const WAITING_KEYFRAMES = `
@keyframes bf-form-spin { to { transform: rotate(360deg); } }
@keyframes bf-form-sweep {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
}
@media (prefers-reduced-motion: reduce) {
    [data-testid="form-waiting"] * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
}
`;

// Short closings ("Thanks!") stay centred under the tick, the way they always
// looked. A long one is a document — centring a blog is unreadable. The same
// split gates the export bar below: a one-line "Thanks!" has nothing worth
// keeping, an automation's real output does.
const LONG_ENDING_CHARS = 240;

/**
 * The generic fallback for a closing page that has no `generate_document`
 * step at all (BFSF-419) — the common case: the automation's whole "result" is
 * markdown sitting in `form.description` (a blog post, a summary, an
 * analysis), with no download/notebook field wired, because the author never
 * added one. Without this, closing the tab loses the text for good.
 *
 * Independent of any download/notebook field on purpose — those need the
 * automation to have produced an actual generated file; this needs nothing
 * from the automation at all, because the text is already sitting right there
 * in the page.
 *
 * "Download as .txt" and "Copy text" are pure client-side operations on the
 * text already in hand — no backend round trip, so they work even in the
 * builder's live preview. Word, PDF, Notebook and Webpage go through the
 * server (it renders or stores the run's own result), so each renders only
 * when the caller hands over a working handler — the same "no handler ⇒ no
 * button" rule the file-based "Open in Notebooks" button follows for the
 * builder preview.
 */
function FormExportBar({ text, title, onDownloadAs, onSaveToNotebook, onSaveAsWebpage }: FormExportBarProps) {
    const { t } = useTranslation();
    // Hooks first, always — the "is this worth exporting?" bail-out below has
    // to come after every hook call, or a length change across renders would
    // call them in a different order.
    const [copied, setCopied] = useState(false);
    // One action at a time: which one is running ('docx', 'pdf', 'notebook',
    // 'webpage'), and what went wrong with the last one.
    const [busy, setBusy] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // Same split the layout above uses to tell a real result from a one-line
    // "Thanks!" — recomputed here (not passed down as a bool) so this stays
    // the one place that decides whether there is something worth exporting.
    if (!text || text.length <= LONG_ENDING_CHARS) return null;

    const downloadTxt = () => {
        // Ship the raw markdown as-is. Stripping `##` / `**` back to plain
        // prose is a project of its own — a .txt with a few stray symbols in
        // it is still far better than a tab the visitor can no longer get back.
        saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), resultFilename(title, 'txt'));
    };

    const copyText = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Denied permission or an insecure context — there is nothing
            // useful to do beyond leaving the button as it was.
        }
    };

    /**
     * Run one server-side action. A save navigates away on success, so its
     * button stays disabled (mirroring "Open in Notebooks": a button that
     * re-enables first reads as "nothing happened, press again"); a download
     * leaves the visitor here and frees the bar again.
     */
    const run = async (key: string, action: (() => Promise<unknown>) | null | undefined, { navigates }: { navigates: boolean }) => {
        if (!action || busy) return;
        setBusy(key);
        setActionError(null);
        try {
            await action();
            if (!navigates) setBusy(null);
        } catch (e) {
            setActionError(messageOf(e, t('forms.result.failed')));
            setBusy(null);
        }
    };

    const actionClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border transition disabled:opacity-60';
    const actionStyle = {
        borderColor: 'var(--border-default)',
        borderRadius: 'var(--app-radius)',
        background: 'var(--bg-card, var(--bg-secondary))',
        color: 'var(--text-primary)',
    };
    const actionButton = (key: string, Icon: LucideIcon, label: string, busyLabel: string, onClick: () => void) => (
        <button
            type="button"
            onClick={onClick}
            disabled={busy === key}
            aria-disabled={busy === key}
            className={actionClass}
            style={actionStyle}
            data-testid={`form-export-${key}`}
        >
            {busy === key ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
            {busy === key ? busyLabel : label}
        </button>
    );

    return (
        <div className="flex flex-col gap-1.5" data-testid="form-export-bar">
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={downloadTxt} className={actionClass} style={actionStyle} data-testid="form-export-download">
                    <Download size={14} /> {t('forms.result.download_txt')}
                </button>
                {onDownloadAs ? (
                    <>
                        {actionButton('docx', FileText, t('forms.result.download_docx'), t('forms.result.preparing'), () => run('docx', () => onDownloadAs('docx'), { navigates: false }))}
                        {actionButton('pdf', FileDown, t('forms.result.download_pdf'), t('forms.result.preparing'), () => run('pdf', () => onDownloadAs('pdf'), { navigates: false }))}
                    </>
                ) : null}
                <button type="button" onClick={copyText} className={actionClass} style={actionStyle} data-testid="form-export-copy">
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('forms.result.copied') : t('forms.result.copy')}
                </button>
                {onSaveToNotebook
                    ? actionButton('notebook', BookOpen, t('forms.result.save_notebook'), t('forms.result.saving'), () => run('notebook', onSaveToNotebook, { navigates: true }))
                    : null}
                {onSaveAsWebpage
                    ? actionButton('webpage', Globe, t('forms.result.save_webpage'), t('forms.result.saving'), () => run('webpage', onSaveAsWebpage, { navigates: true }))
                    : null}
            </div>
            {actionError ? <p className="text-xs text-[#ef4444]" role="alert">{actionError}</p> : null}
        </div>
    );
}

/**
 * The visitor's last screen: a single-page form's success message, or a
 * `form_page` step with mode 'ending' — which the server renders against the
 * finished run, so its text can be a summary of what actually happened.
 *
 * Same theme plumbing as the form, so the journey does not change appearance
 * on its final step.
 */
export function FormEndingView({ form, downloadHref = null, onOpenInNotebooks = null, onSaveToNotebook = null, onSaveAsWebpage, onDownloadAs }: FormEndingViewProps) {
    const style = useMemo(() => themeVars(form?.theme || {}), [form]);
    const description = form?.description || '';
    const isLong = description.length > LONG_ENDING_CHARS;
    return (
        <div style={style} className="w-full" data-testid="form-ending">
            <div
                className={`flex flex-col gap-3 px-6 py-10 border ${isLong ? 'items-stretch text-left' : 'items-center text-center'}`}
                style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-card, var(--bg-secondary))' }}
            >
                <span
                    className={`h-11 w-11 flex items-center justify-center ${isLong ? 'self-center' : ''}`}
                    style={{ background: 'var(--app-primary)', color: 'var(--app-primary-contrast)', borderRadius: '999px' }}
                >
                    <Check size={22} />
                </span>
                <p className={`text-base font-medium ${isLong ? 'self-center text-center' : ''}`} style={{ color: 'var(--text-primary)' }}>
                    {form?.title || 'Thanks — we got your answer.'}
                </p>
                {description ? (
                    <>
                        <FormRichText className="text-sm" style={{ color: 'var(--text-secondary)' }}>{description}</FormRichText>
                        {/* The generic fallback: whatever produced this text is
                            otherwise gone the moment the tab closes. FormExportBar
                            itself decides whether description is substantial
                            enough to bother with — nothing else here needs to
                            know that threshold. */}
                        <FormExportBar
                            text={description}
                            title={form?.title}
                            onDownloadAs={onDownloadAs}
                            onSaveToNotebook={onSaveToNotebook}
                            onSaveAsWebpage={onSaveAsWebpage}
                        />
                    </>
                ) : null}
                {/* The closing page is where a produced document usually lands
                    — "here is the thing the automation just made for you". Only
                    display fields render here; a closing page collects nothing,
                    so anything else on it would have no way to be submitted. */}
                {(form?.fields || []).filter(isDisplayField).map(field => (
                    <FormField key={field.name} field={field} downloadHref={downloadHref ? downloadHref(field) : null} onOpenInNotebooks={onOpenInNotebooks} />
                ))}
            </div>
        </div>
    );
}
