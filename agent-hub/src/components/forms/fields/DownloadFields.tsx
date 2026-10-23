import React, { useState } from 'react';
import { BookOpen, Download, Loader2 } from 'lucide-react';
import { messageOf } from '../../../utils/caughtError';
import type { FormFieldDef } from '../PublicFormRenderer.types';

/** Human file size. 1 decimal from MB up, none below — "0.9 kB" reads as noise. */
function fileSize(bytes: unknown): string {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The extension, upper-cased, as a type chip: PDF, DOCX. */
function fileKind(filename: unknown): string {
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
export function FormDownload({ field, href }: { field: FormFieldDef; href?: string | null }) {
    const meta = [fileKind(field.filename), fileSize(field.size)].filter(Boolean).join(' · ');
    if (!href) return <FormDownloadUnavailable field={field} meta={meta} />;
    return (
        <div className="flex flex-col gap-1 text-left" data-testid={`form-download-${field.name}`}>
            {field.label ? (
                <span className="text-sm font-medium text-[var(--text-primary)]">{field.label}</span>
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
                    {meta ? <span className="text-xs text-[var(--text-secondary)]">{meta}</span> : null}
                </span>
            </a>
            {field.help ? <p className="text-xs text-[var(--text-muted)]">{field.help}</p> : null}
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
export function FormOpenInNotebooks({ field, onOpen }: { field: FormFieldDef; onOpen?: ((field: FormFieldDef) => Promise<unknown>) | null }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const meta = [fileKind(field.filename), fileSize(field.size)].filter(Boolean).join(' · ');

    const open = async () => {
        if (!onOpen || busy) return;
        setBusy(true);
        setError(null);
        try {
            await onOpen(field);
        } catch (e) {
            setError(messageOf(e, 'Could not open this in Notebooks.'));
            setBusy(false);
        }
        // No setBusy(false) on success: the page is navigating away, and
        // flipping the button back first makes it look like nothing happened.
    };

    return (
        <div className="flex flex-col gap-1 text-left" data-testid={`form-notebook-${field.name}`}>
            {field.label ? (
                <span className="text-sm font-medium text-[var(--text-primary)]">{field.label}</span>
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
                    {meta ? <span className="text-xs text-[var(--text-secondary)]">{meta}</span> : null}
                </span>
            </button>
            {error ? <p className="text-xs" role="alert" style={{ color: '#ef4444' }}>{error}</p> : null}
            {field.help ? <p className="text-xs text-[var(--text-muted)]">{field.help}</p> : null}
        </div>
    );
}

/** The same card, inert — shown when there is no link to give (also the builder preview). */
function FormDownloadUnavailable({ field, meta }: { field: FormFieldDef; meta: string }) {
    return (
        <div className="flex flex-col gap-1 text-left" data-testid={`form-download-${field.name}`}>
            {field.label ? (
                <span className="text-sm font-medium text-[var(--text-primary)]">{field.label}</span>
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
            {field.help ? <p className="text-xs text-[var(--text-muted)]">{field.help}</p> : null}
        </div>
    );
}
