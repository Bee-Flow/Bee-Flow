import React, { useState } from 'react';
import { Loader2, Check, Download, BookOpen, Copy, FileText, FileDown, Globe, type LucideIcon } from 'lucide-react';
import { resultFilename, saveBlob } from './resultFile';
import useTranslation from '../../hooks/useTranslation';
import { messageOf } from '../../utils/caughtError';
import FormField from './fields/FormField';
import { FormRichText } from './fields/FormRichText';
import { isDisplayField } from './formRules';
import { FormCustomCss, FormFooter, FormLogo } from './FormChrome';
import { CARD_CLASS, useFormLook } from './formLook';
import type { FormEndingViewProps, FormExportBarProps } from './PublicFormRenderer.types';
import { logger } from '../../utils/logger';

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
        } catch (err) { logger.debug('Denied permission or an insecure context — there is nothing useful to do beyond leaving the button as it was.', err); }
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

    const actionClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border transition disabled:opacity-60 [border-color:var(--border-default)] [border-radius:var(--app-radius)] [background:var(--bg-card,var(--bg-secondary))] text-[var(--text-primary)]';
    const actionButton = (key: string, Icon: LucideIcon, label: string, busyLabel: string, onClick: () => void) => (
        <button
            type="button"
            onClick={onClick}
            disabled={busy === key}
            aria-disabled={busy === key}
            className={actionClass}
            data-testid={`form-export-${key}`}
        >
            {busy === key ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
            {busy === key ? busyLabel : label}
        </button>
    );

    return (
        <div className="flex flex-col gap-1.5" data-testid="form-export-bar">
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={downloadTxt} className={actionClass} data-testid="form-export-download">
                    <Download size={14} /> {t('forms.result.download_txt')}
                </button>
                {onDownloadAs ? (
                    <>
                        {actionButton('docx', FileText, t('forms.result.download_docx'), t('forms.result.preparing'), () => run('docx', () => onDownloadAs('docx'), { navigates: false }))}
                        {actionButton('pdf', FileDown, t('forms.result.download_pdf'), t('forms.result.preparing'), () => run('pdf', () => onDownloadAs('pdf'), { navigates: false }))}
                    </>
                ) : null}
                <button type="button" onClick={copyText} className={actionClass} data-testid="form-export-copy">
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

/** The tick and the closing line; a long ending keeps them centred above its left-aligned text. */
function EndingHeadline({ title, isLong }: { title?: string; isLong: boolean }) {
    return (
        <>
            <span
                className={`h-11 w-11 flex items-center justify-center ${isLong ? 'self-center' : ''} [background:var(--app-primary)] [color:var(--app-primary-contrast)] [border-radius:999px]`}
            >
                <Check size={22} />
            </span>
            <p className={`bf-form__title text-base font-medium ${isLong ? 'self-center text-center' : ''} text-[var(--bf-text,var(--text-primary))]`}>
                {title || 'Thanks — we got your answer.'}
            </p>
        </>
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
    const look = useFormLook(form?.theme, form?.style);
    const description = form?.description || '';
    const isLong = description.length > LONG_ENDING_CHARS;
    return (
        <div style={look.rootStyle} data-bf-scope={look.scopeId} className={look.rootClass} data-testid="form-ending">
            <FormCustomCss css={look.css} />
            <div className={`bf-form__ending flex flex-col gap-3 px-6 py-10 ${isLong ? 'items-stretch text-left' : 'items-center text-center'} ${CARD_CLASS}`}>
                <FormLogo url={look.style.logoUrl} />
                <EndingHeadline title={form?.title} isLong={isLong} />
                {description ? (
                    <>
                        <FormRichText className="bf-form__intro text-sm text-[var(--text-secondary)]">{description}</FormRichText>
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
                <FormFooter text={look.style.footerText} />
            </div>
        </div>
    );
}
