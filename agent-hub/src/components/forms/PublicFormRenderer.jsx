import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Paperclip, Check, X, Download, BookOpen, Copy, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import themeVars from '../admin/Studio/AppStudio/runtime/themeVars';
import { Field, INPUT_CLASS, inputStyle } from '../admin/Studio/AppStudio/runtime/uiBits';
import { normaliseOptions } from './formOptions';

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
export default function PublicFormRenderer({ form, onSubmit = null, onUpload = null, onSearchApp = null, preview = false, showSuccess = true, downloadHref = null, onOpenInNotebooks = null }) {
    const fields = form?.fields || [];
    const theme = form?.theme || {};

    const [values, setValues] = useState(() => initialValues(fields));
    const [errors, setErrors] = useState({});
    const [formError, setFormError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    // The honeypot. Never labelled, never in the tab order, never on screen —
    // only a bot that fills every input it finds will touch it.
    const [honeypot, setHoneypot] = useState('');

    const style = useMemo(() => themeVars(theme), [theme]);
    const set = (name, v) => {
        setValues(prev => ({ ...prev, [name]: v }));
        setErrors(prev => (prev[name] ? { ...prev, [name]: null } : prev));
    };

    const submit = async (e) => {
        e.preventDefault();
        if (preview || !onSubmit || busy) return;
        // Client-side required checks are a courtesy, not a gate — the server
        // re-checks every field against the declaration.
        const missing = {};
        for (const f of fields) {
            if (isDisplayField(f) || !f.required) continue;
            if (isBlank(f, values[f.name])) missing[f.name] = `${f.label} is required.`;
        }
        if (Object.keys(missing).length) { setErrors(missing); return; }

        setBusy(true);
        setFormError(null);
        try {
            await onSubmit({ ...values, website_url: honeypot });
            if (showSuccess) setDone(true);
        } catch (err) {
            const perField = err?.fields;
            if (Array.isArray(perField) && perField.length) {
                setErrors(Object.fromEntries(perField.map(f => [f.field, f.message])));
            } else {
                setFormError(err?.message || 'Something went wrong. Please try again.');
            }
        } finally {
            setBusy(false);
        }
    };

    if (done) return <FormEndingView form={{ ...form, title: form.successMessage, description: '' }} />;

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

                {fields.map(field => (
                    <FormField
                        key={field.name}
                        field={field}
                        value={values[field.name]}
                        error={errors[field.name] || null}
                        disabled={preview || busy}
                        onChange={(v) => set(field.name, v)}
                        onUpload={onUpload}
                        onSearchApp={onSearchApp}
                        onError={(msg) => setErrors(prev => ({ ...prev, [field.name]: msg }))}
                        downloadHref={downloadHref ? downloadHref(field) : null}
                        onOpenInNotebooks={onOpenInNotebooks}
                    />
                ))}

                {/* Honeypot — hidden from people AND from assistive tech, so
                    only an indiscriminate bot fills it in. */}
                <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
                    <label htmlFor="website_url">Leave this field empty</label>
                    <input id="website_url" name="website_url" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
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

/**
 * The visitor's last screen: a single-page form's success message, or a
 * `form_page` step with mode 'ending' — which the server renders against the
 * finished run, so its text can be a summary of what actually happened.
 *
 * Same theme plumbing as the form, so the journey does not change appearance
 * on its final step.
 */
// Every description on a form page — a mid-run question as much as the closing
// summary — is where the automation SHOWS the visitor something: the keyword it
// picked and why, the competitor analysis it just did, the text it wrote, a
// link to the document. Rendered as a flat paragraph that meant reading raw
// `##` and `**` and copy-pasting URLs by hand.
//
// react-markdown escapes embedded HTML unless rehype-raw is added; it is not
// added, deliberately. These pages are served to anonymous visitors and their
// text can carry model output, so nothing here may become live markup.
const FORM_MD_COMPONENTS = {
    a: ({ node: _node, ...props }) => (
        <a {...props} target="_blank" rel="noopener noreferrer nofollow"
            style={{ color: 'var(--app-primary)', textDecoration: 'underline' }} />
    ),
    h1: ({ node: _node, ...props }) => <h2 {...props} className="text-lg font-semibold mt-5 mb-2" style={{ color: 'var(--text-primary)' }} />,
    h2: ({ node: _node, ...props }) => <h3 {...props} className="text-base font-semibold mt-5 mb-1.5" style={{ color: 'var(--text-primary)' }} />,
    h3: ({ node: _node, ...props }) => <h4 {...props} className="text-sm font-semibold mt-4 mb-1" style={{ color: 'var(--text-primary)' }} />,
    p: ({ node: _node, ...props }) => <p {...props} className="mb-3" />,
    ul: ({ node: _node, ...props }) => <ul {...props} className="list-disc pl-5 mb-3 flex flex-col gap-1" />,
    ol: ({ node: _node, ...props }) => <ol {...props} className="list-decimal pl-5 mb-3 flex flex-col gap-1" />,
    strong: ({ node: _node, ...props }) => <strong {...props} style={{ color: 'var(--text-primary)' }} />,
    hr: ({ node: _node, ...props }) => <hr {...props} className="my-5" style={{ borderColor: 'var(--border-subtle)' }} />,
    blockquote: ({ node: _node, ...props }) => (
        <blockquote {...props} className="pl-3 my-3" style={{ borderLeft: '3px solid var(--border-default)' }} />
    ),
    // GFM tables had no entry here at all, so they rendered as a bare <table>
    // with zero cell padding: the widest label in a two-column fact table ran
    // straight into its value ("Director ruleauto"). A snapshot table is the
    // most common thing an approval's details block contains, and a form
    // description's second most common, so it gets real cells — and a scroll
    // box, so a wide one cannot push the column sideways.
    table: ({ node: _node, ...props }) => (
        <div className="my-3 overflow-x-auto">
            <table {...props} className="w-auto min-w-0 border-collapse text-left" />
        </div>
    ),
    th: ({ node: _node, ...props }) => (
        <th {...props} className="py-1 pr-6 last:pr-0 align-top font-semibold" style={{ color: 'var(--text-primary)' }} />
    ),
    td: ({ node: _node, ...props }) => <td {...props} className="py-1 pr-6 last:pr-0 align-top" />,
};

export function FormRichText({ children, className = '', style = null }) {
    return (
        <div className={className} style={style}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={FORM_MD_COMPONENTS}>{children}</ReactMarkdown>
        </div>
    );
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
export function FormWaitingView({ theme = null, progress = null, note = null, label = 'Working on it' }) {
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
                                className="text-[11px] font-medium uppercase tracking-wide truncate"
                                style={{ color: 'var(--app-primary)' }}
                                title={context.join(' › ')}
                            >
                                {context.join(' › ')}
                            </span>
                        ) : null}
                        <span className="text-base font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
                            {current || `${label}…`}
                        </span>
                        {summary ? (
                            <span
                                className="text-xs leading-relaxed"
                                data-testid="form-waiting-note"
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                {summary}
                            </span>
                        ) : null}
                        <span className="text-xs" style={{ color: summary ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
                            {current ? `${label} — this can take a moment.` : 'This can take a moment.'}
                        </span>
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
 * step at all (BFSF-419, Track 1) — the common case: the automation's whole
 * "result" is markdown sitting in `form.description` (a blog post, a
 * summary, an analysis), with no download/notebook field wired, because the
 * author never added one. Without this, closing the tab loses the text for
 * good.
 *
 * Independent of any download/notebook field on purpose — those need the
 * automation to have produced an actual generated file; this needs nothing
 * from the automation at all, because the text is already sitting right there
 * in the page.
 *
 * "Download as .txt" and "Copy text" are pure client-side operations on the
 * text already in hand — no backend round trip, so they work even in the
 * builder's live preview. "Save to Notebook" is a write (it needs a real,
 * signed-in visitor and a real session to attribute it to), so it renders
 * only when the caller hands over a working `onSaveToNotebook` — exactly the
 * same "no handler ⇒ no button" rule the file-based "Open in Notebooks"
 * button already follows for the builder preview.
 */
function FormExportBar({ text, filename, onSaveToNotebook }) {
    // Hooks first, always — the "is this worth exporting?" bail-out below has
    // to come after every hook call, or a length change across renders would
    // call them in a different order.
    const [copied, setCopied] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);

    // Same split the layout above uses to tell a real result from a one-line
    // "Thanks!" — recomputed here (not passed down as a bool) so this stays
    // the one place that decides whether there is something worth exporting.
    if (!text || text.length <= LONG_ENDING_CHARS) return null;

    const downloadTxt = () => {
        // Ship the raw markdown as-is. Stripping `##` / `**` back to plain
        // prose is a project of its own — a .txt with a few stray symbols in
        // it is still far better than a tab the visitor can no longer get back.
        // A Blob + object URL, same as every other export-to-file button on
        // this stack (RowBrowser's CSV export, the CMS page export) — never
        // an `<a href>` at a real endpoint, which carries no auth header.
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
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

    const saveToNotebook = async () => {
        if (!onSaveToNotebook || saving) return;
        setSaving(true);
        setSaveError(null);
        try {
            await onSaveToNotebook();
            // No setSaving(false) on success, mirroring "Open in Notebooks":
            // the page is about to navigate away.
        } catch (e) {
            setSaveError(e?.message || 'Could not save this to Notebooks.');
            setSaving(false);
        }
    };

    const actionClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border transition disabled:opacity-60';
    const actionStyle = {
        borderColor: 'var(--border-default)',
        borderRadius: 'var(--app-radius)',
        background: 'var(--bg-card, var(--bg-secondary))',
        color: 'var(--text-primary)',
    };

    return (
        <div className="flex flex-col gap-1.5" data-testid="form-export-bar">
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={downloadTxt} className={actionClass} style={actionStyle} data-testid="form-export-download">
                    <Download size={14} /> Download as .txt
                </button>
                <button type="button" onClick={copyText} className={actionClass} style={actionStyle} data-testid="form-export-copy">
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy text'}
                </button>
                {onSaveToNotebook ? (
                    <button
                        type="button"
                        onClick={saveToNotebook}
                        disabled={saving}
                        aria-disabled={saving}
                        className={actionClass}
                        style={actionStyle}
                        data-testid="form-export-notebook"
                    >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <BookOpen size={14} />}
                        {saving ? 'Saving…' : 'Save to Notebook'}
                    </button>
                ) : null}
            </div>
            {saveError ? <p className="text-xs" role="alert" style={{ color: '#ef4444' }}>{saveError}</p> : null}
        </div>
    );
}

export function FormEndingView({ form, downloadHref = null, onOpenInNotebooks = null, onSaveToNotebook = null }) {
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
                        <FormExportBar text={description} filename={txtFilename(form?.title)} onSaveToNotebook={onSaveToNotebook} />
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

/** A safe, boring .txt filename from the closing page's own title. */
function txtFilename(title) {
    const base = String(title || 'result').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `${base || 'result'}.txt`;
}

// Display-only field types: they show something instead of collecting it, so
// they get no entry in `values` and are skipped by the required check. Mirrors
// the server's DISPLAY_FIELD_TYPES in automation/formTriggerContract.js.
const DISPLAY_FIELD_TYPES = ['download', 'notebook'];
const isDisplayField = (f) => DISPLAY_FIELD_TYPES.includes(f?.type);

/**
 * The form's key set with every answer empty — the shape a submission has
 * before anyone types anything.
 *
 * Exported (BFSF-408b) because it is also the free answer to "what does this
 * trigger hand my next step?": the automation builder seeds an edited trigger
 * payload from it, so the author sees every declared key without filling the
 * form in. Deliberately the SAME function the renderer seeds its own state
 * with — a second generator would drift from the real submission shape (the
 * placeholder-value samples in Builder/mapping/upstream.js are a different
 * thing: they show what a value LOOKS like, not what an empty form sends).
 */
export function initialValues(fields) {
    const out = {};
    for (const f of (Array.isArray(fields) ? fields : [])) {
        if (isDisplayField(f)) continue;
        // Mirrors the server's emptyValue() in automation/formTriggerContract.js:
        // an unanswered pick is an empty LIST when the question takes several
        // records, and null when it takes one.
        out[f.name] = f.type === 'checkbox' ? false
            : f.type === 'file' ? null
                : f.type === 'app_pick' ? (f.multiple ? [] : null)
                    : '';
    }
    return out;
}

function isBlank(field, value) {
    if (field.type === 'checkbox') return value !== true;
    if (field.type === 'file') return !value;
    if (field.type === 'app_pick') return Array.isArray(value) ? value.length === 0 : !value;
    return value === undefined || value === null || String(value).trim() === '';
}

/** Human file size. 1 decimal from MB up, none below — "0.9 kB" reads as noise. */
function fileSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The extension, upper-cased, as a type chip: PDF, DOCX. */
function fileKind(filename) {
    const m = /\.([a-z0-9]{1,5})$/i.exec(String(filename || ''));
    return m ? m[1].toUpperCase() : '';
}

/**
 * The document the automation produced, offered as a download.
 *
 * A plain anchor, not a fetch: the browser's own download handling is what a
 * visitor expects, works without JavaScript state, and keeps the bytes out of
 * page memory. `download` asks for a save rather than a render; the server
 * sends `Content-Disposition: attachment` regardless, so this is a nicety
 * rather than the guarantee.
 *
 * With no href it must NOT render a link. `<a href="#" download="test.pdf">`
 * makes the browser save the CURRENT PAGE under that name, so a missing link
 * arrived as a 6 KB index.html called test.pdf — "Failed to load PDF document"
 * in Chrome, "unreadable content" in Word. A visibly dead button is the honest
 * failure; a corrupt download is not.
 */
function FormDownload({ field, href }) {
    const meta = [fileKind(field.filename), fileSize(field.size)].filter(Boolean).join(' · ');
    if (!href) return <FormDownloadUnavailable field={field} meta={meta} />;
    return (
        <div className="flex flex-col gap-1 text-left" data-testid={`form-download-${field.name}`}>
            {field.label ? (
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{field.label}</span>
            ) : null}
            <a
                href={href}
                download={field.filename || true}
                className="flex items-center gap-3 px-3 py-2.5 border transition"
                style={{
                    borderColor: 'var(--border-default)',
                    borderRadius: 'var(--app-radius)',
                    background: 'var(--bg-card, var(--bg-secondary))',
                    color: 'var(--text-primary)',
                    textDecoration: 'none',
                }}
            >
                <span
                    aria-hidden="true"
                    className="flex items-center justify-center flex-shrink-0"
                    style={{ width: 34, height: 34, borderRadius: '999px', background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
                >
                    <Download size={16} />
                </span>
                <span className="min-w-0 flex flex-col">
                    <span className="text-sm font-medium truncate">{field.filename || 'Download'}</span>
                    {meta ? <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{meta}</span> : null}
                </span>
            </a>
            {field.help ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{field.help}</p> : null}
        </div>
    );
}

/**
 * "Open in Notebooks" — the download's twin for a document you want to work
 * with rather than file away.
 *
 * It is a BUTTON, not a link, because opening is a write: the server copies the
 * document into a new notebook and only then is there an address to go to. That
 * also means it can fail, so it says so instead of navigating nowhere.
 *
 * Without a handler (the builder preview) it renders inert, exactly as the
 * download does — the author sees the shape without a live notebook being made
 * every time they look at the page.
 */
function FormOpenInNotebooks({ field, onOpen }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const meta = [fileKind(field.filename), fileSize(field.size)].filter(Boolean).join(' · ');

    const open = async () => {
        if (!onOpen || busy) return;
        setBusy(true);
        setError(null);
        try {
            await onOpen(field);
        } catch (e) {
            setError(e?.message || 'Could not open this in Notebooks.');
            setBusy(false);
        }
        // No setBusy(false) on success: the page is navigating away, and
        // flipping the button back first makes it look like nothing happened.
    };

    return (
        <div className="flex flex-col gap-1 text-left" data-testid={`form-notebook-${field.name}`}>
            {field.label ? (
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{field.label}</span>
            ) : null}
            <button
                type="button"
                onClick={open}
                disabled={!onOpen || busy}
                aria-disabled={!onOpen || busy}
                className="flex items-center gap-3 px-3 py-2.5 border transition text-left disabled:opacity-60"
                style={{
                    borderColor: 'var(--border-default)',
                    borderRadius: 'var(--app-radius)',
                    background: 'var(--bg-card, var(--bg-secondary))',
                    color: 'var(--text-primary)',
                }}
            >
                <span
                    aria-hidden="true"
                    className="flex items-center justify-center flex-shrink-0"
                    style={{ width: 34, height: 34, borderRadius: '999px', background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
                >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <BookOpen size={16} />}
                </span>
                <span className="min-w-0 flex flex-col">
                    <span className="text-sm font-medium truncate">
                        {busy ? 'Opening in Notebooks…' : (field.filename || 'Open in Notebooks')}
                    </span>
                    {meta ? <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{meta}</span> : null}
                </span>
            </button>
            {error ? <p className="text-xs" role="alert" style={{ color: '#ef4444' }}>{error}</p> : null}
            {field.help ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{field.help}</p> : null}
        </div>
    );
}

/** The same card, inert — shown when there is no link to give (also the builder preview). */
function FormDownloadUnavailable({ field, meta }) {
    return (
        <div className="flex flex-col gap-1 text-left" data-testid={`form-download-${field.name}`}>
            {field.label ? (
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{field.label}</span>
            ) : null}
            <div
                className="flex items-center gap-3 px-3 py-2.5 border"
                aria-disabled="true"
                style={{
                    borderColor: 'var(--border-default)',
                    borderRadius: 'var(--app-radius)',
                    background: 'var(--bg-card, var(--bg-secondary))',
                    color: 'var(--text-secondary)',
                    opacity: 0.65,
                }}
            >
                <span
                    aria-hidden="true"
                    className="flex items-center justify-center flex-shrink-0"
                    style={{ width: 34, height: 34, borderRadius: '999px', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
                >
                    <Download size={16} />
                </span>
                <span className="min-w-0 flex flex-col">
                    <span className="text-sm font-medium truncate">{field.filename || 'Download'}</span>
                    {meta ? <span className="text-xs">{meta}</span> : null}
                </span>
            </div>
            {field.help ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{field.help}</p> : null}
        </div>
    );
}

function FormField({ field, value, error, disabled, onChange, onUpload, onSearchApp, onError, downloadHref, onOpenInNotebooks }) {
    const id = `ff_${field.name}`;
    const common = { id, name: field.name, disabled, className: INPUT_CLASS, style: inputStyle(!!error) };

    // A download is the one field that GIVES rather than asks: the automation made
    // a document and this hands it over. It collects nothing, so it has no
    // value, no error and no place in the submission.
    if (field.type === 'download') return <FormDownload field={field} href={downloadHref} />;
    if (field.type === 'notebook') return <FormOpenInNotebooks field={field} onOpen={onOpenInNotebooks} />;

    if (field.type === 'checkbox') {
        return (
            <div className="flex flex-col gap-1 text-left">
                <label htmlFor={id} className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                    <input
                        id={id}
                        name={field.name}
                        type="checkbox"
                        disabled={disabled}
                        checked={value === true}
                        onChange={(e) => onChange(e.target.checked)}
                        className="mt-0.5"
                        style={{ accentColor: 'var(--app-primary)' }}
                    />
                    <span>
                        {field.label}
                        {field.required ? <span aria-hidden="true" style={{ color: '#ef4444' }}> *</span> : null}
                    </span>
                </label>
                {field.help ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{field.help}</p> : null}
                {error ? <p className="text-xs" role="alert" style={{ color: '#ef4444' }}>{error}</p> : null}
            </div>
        );
    }

    return (
        <Field id={id} label={field.label} required={field.required} error={error}>
            {field.type === 'textarea' ? (
                <textarea {...common} rows={5} value={value || ''} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
            ) : field.type === 'select' ? (
                <select {...common} value={value || ''} onChange={(e) => onChange(e.target.value)}>
                    <option value="">{field.placeholder || 'Choose…'}</option>
                    {normaliseOptions(field.options).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            ) : field.type === 'file' ? (
                <FileField field={field} value={value} disabled={disabled} onChange={onChange} onUpload={onUpload} onError={onError} />
            ) : field.type === 'app_pick' ? (
                <AppPickField field={field} value={value} disabled={disabled} onChange={onChange} onSearch={onSearchApp} />
            ) : (
                <input
                    {...common}
                    type={field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                    value={value ?? ''}
                    placeholder={field.placeholder}
                    onChange={(e) => onChange(e.target.value)}
                />
            )}
            {field.help ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{field.help}</p> : null}
        </Field>
    );
}

/**
 * "Pick from an app": search the app the question names, choose a record.
 *
 * What travels with the submission is a REFERENCE — `{ kind:'app_pick',
 * recordId, title }` — never the record itself. The server re-reads the record
 * as the person submitting, at submit time, which is what keeps this from being
 * a way to post someone else's transcript into an automation by hand-crafting a
 * body.
 *
 * The search runs against the FILLER's own account. So "no results" here can
 * mean "you have not connected this app", and the server says which — printed
 * next to the box rather than thrown, because it is not the person's mistake.
 */
function AppPickField({ field, value, disabled, onChange, onSearch }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [note, setNote] = useState('');
    const [opened, setOpened] = useState(false);

    const picked = useMemo(
        () => (Array.isArray(value) ? value : (value ? [value] : [])),
        [value],
    );
    const full = field.multiple ? picked.length >= (field.maxItems || 5) : picked.length >= 1;

    // Debounced, and only while the picker is open. The search hits the app the
    // question names on every pause in typing, so a keystroke-per-request would
    // be both slow and rude to the upstream API.
    useEffect(() => {
        if (!opened || !onSearch) return undefined;
        let live = true;
        setSearching(true);
        const timer = setTimeout(async () => {
            try {
                const out = await onSearch(field, query);
                if (!live) return;
                setResults(Array.isArray(out?.results) ? out.results : []);
                setNote(out?.error || '');
            } catch (err) {
                if (!live) return;
                setResults([]);
                setNote(err?.message || 'That app could not be searched.');
            } finally {
                if (live) setSearching(false);
            }
        }, 300);
        return () => { live = false; clearTimeout(timer); };
    }, [opened, query, onSearch, field]);

    const add = (row) => {
        const pick = { kind: 'app_pick', source: field.source, recordId: row.id, title: row.title };
        if (field.multiple) {
            if (picked.some(p => p.recordId === row.id)) return;
            onChange([...picked, pick]);
        } else {
            onChange(pick);
            setOpened(false);
        }
        setQuery('');
    };

    const remove = (recordId) => {
        if (field.multiple) onChange(picked.filter(p => p.recordId !== recordId));
        else onChange(null);
    };

    return (
        <div className="flex flex-col gap-2" data-testid={`form-apppick-${field.name}`}>
            {picked.map(p => (
                <div
                    key={p.recordId}
                    className="flex items-center gap-2 px-3 py-2 border text-sm"
                    style={{
                        borderColor: 'var(--border-default)',
                        borderRadius: 'var(--app-radius)',
                        background: 'var(--bg-card, var(--bg-secondary))',
                        color: 'var(--text-primary)',
                    }}
                >
                    <Check size={14} aria-hidden="true" style={{ color: 'var(--app-primary)', flexShrink: 0 }} />
                    <span className="min-w-0 flex-1 truncate">{p.title || p.recordId}</span>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => remove(p.recordId)}
                        aria-label={`Remove ${p.title || p.recordId}`}
                        style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}
                    >
                        <X size={14} />
                    </button>
                </div>
            ))}

            {!full && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setOpened(v => !v)}
                    className="flex items-center gap-2 px-3 py-2 border text-sm"
                    style={{
                        borderColor: 'var(--border-default)',
                        borderRadius: 'var(--app-radius)',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                    }}
                >
                    <Search size={14} aria-hidden="true" />
                    <span>{picked.length ? `Add another from ${field.app || 'the app'}` : `Choose from ${field.app || 'an app'}`}</span>
                </button>
            )}

            {opened && !full && (
                <div
                    className="flex flex-col gap-1 p-2 border"
                    style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-card, var(--bg-secondary))' }}
                >
                    <input
                        type="text"
                        autoFocus
                        disabled={disabled}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={field.searchHint || `Search ${field.app || ''}`.trim()}
                        className={INPUT_CLASS}
                        style={inputStyle(false)}
                        aria-label={`Search ${field.app || 'the app'}`}
                    />
                    {searching && (
                        <span className="flex items-center gap-1.5 px-1 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            <Loader2 size={12} className="animate-spin" /> Searching…
                        </span>
                    )}
                    {!searching && note && (
                        <p className="px-1 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>{note}</p>
                    )}
                    {!searching && !note && results.length === 0 && (
                        <p className="px-1 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {onSearch ? 'Nothing found.' : 'The search runs on the live form.'}
                        </p>
                    )}
                    {results.map(row => (
                        <button
                            key={row.id}
                            type="button"
                            disabled={disabled || picked.some(p => p.recordId === row.id)}
                            onClick={() => add(row)}
                            className="flex flex-col items-start gap-0.5 px-2 py-1.5 text-left text-sm"
                            style={{ borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' }}
                        >
                            <span className="w-full truncate font-medium">{row.title}</span>
                            {row.subtitle ? (
                                <span className="w-full truncate text-xs" style={{ color: 'var(--text-muted)' }}>{row.subtitle}</span>
                            ) : null}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * A file field uploads immediately and keeps only the DESCRIPTOR. Bytes never
 * travel with the submission, so a large attachment can't blow the body limit
 * and a failed submit doesn't mean re-picking the file.
 */
function FileField({ field, value, disabled, onChange, onUpload, onError }) {
    const [uploading, setUploading] = useState(false);

    const pick = async (e) => {
        const file = e.target.files?.[0];
        // Let the same file be picked again after a failure.
        e.target.value = '';
        if (!file || !onUpload) return;
        if (file.size > field.maxSizeMb * 1024 * 1024) {
            onError(`That file is larger than ${field.maxSizeMb} MB.`);
            return;
        }
        setUploading(true);
        try {
            const uploaded = await onUpload(file, field.name);
            onChange({ kind: 'form_upload', fileId: uploaded.fileId, filename: uploaded.filename, size: uploaded.size });
        } catch (err) {
            onError(err?.message || 'That file could not be uploaded.');
        } finally {
            setUploading(false);
        }
    };

    if (value) {
        return (
            <div
                className="flex items-center gap-2 px-2.5 py-1.5 text-sm border"
                style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' }}
            >
                <Paperclip size={14} style={{ color: 'var(--app-primary)' }} />
                <span className="truncate flex-1 min-w-0">{value.filename}</span>
                <button
                    type="button"
                    onClick={() => onChange(null)}
                    disabled={disabled}
                    aria-label={`Remove ${value.filename}`}
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <X size={14} />
                </button>
            </div>
        );
    }

    return (
        <label
            className="flex items-center gap-2 px-2.5 py-1.5 text-sm border cursor-pointer"
            style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-secondary)' }}
        >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
            <span>{uploading ? 'Uploading…' : `Choose a file (max ${field.maxSizeMb} MB)`}</span>
            <input
                type="file"
                className="sr-only"
                accept={field.accept || undefined}
                disabled={disabled || uploading}
                onChange={pick}
            />
        </label>
    );
}
