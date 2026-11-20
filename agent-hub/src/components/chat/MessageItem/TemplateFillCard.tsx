/**
 * The card under an answer in which the assistant is filling in a template
 * with the user: the document's name, how far the filling is ("4 of 6 fields
 * filled in", what is still needed), and once template_fill_finish answered,
 * the download (PDF, or PowerPoint for a presentation) and "Open in
 * Documents" (DocumentLinkCard, which opens it beside the chat).
 */
import { useState } from 'react';
import { Download, FilePen } from 'lucide-react';

import { downloadFilledDocument } from '@/api/filledDocumentDownload';
import useTranslation from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';
import DocumentLinkCard from '../../documents/DocumentLinkCard';
import { templateFillStates, type TemplateFillState } from './templateFillResults';

const MAX_MISSING_SHOWN = 4;

type DownloadFn = typeof downloadFilledDocument;

/** Tailwind width steps for the progress bar (a class per tenth, no inline style). */
const WIDTHS = ['w-0', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]', 'w-1/2', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-full'];

function FillProgress({ state }: { state: TemplateFillState }) {
    const { t } = useTranslation();
    const step = state.total > 0 ? Math.round((state.filled / state.total) * 10) : 0;
    const missing = state.missing.slice(0, MAX_MISSING_SHOWN).join(', ') + (state.missing.length > MAX_MISSING_SHOWN ? ', …' : '');
    return (
        <>
            <p className="m-0 text-xs text-[var(--text-secondary)]" data-testid="template-fill-progress">
                {t('chat_templates.card_progress', '{filled} of {total} fields filled in', { filled: state.filled, total: state.total })}
            </p>
            <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" aria-hidden="true">
                <div className={`h-full bg-[var(--accent-primary)] ${WIDTHS[Math.min(Math.max(step, 0), 10)]}`} />
            </div>
            {missing && (
                <p className="m-0 text-xs text-[var(--text-tertiary)]">
                    {t('chat_templates.card_missing', 'Still needed: {fields}', { fields: missing })}
                </p>
            )}
        </>
    );
}

function FinishedActions({ state, download }: { state: TemplateFillState; download: DownloadFn }) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const onDownload = async () => {
        setBusy(true);
        setFailed(false);
        try {
            await download(state.documentId, state.name, state.format);
        } catch (err) {
            logger.debug('filled document download failed', err);
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <p className="m-0 text-xs text-[var(--text-secondary)]">{t('chat_templates.card_ready', 'Ready to download')}</p>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={onDownload}
                    disabled={busy}
                    data-testid="template-fill-download"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)] disabled:opacity-60"
                >
                    <Download size={14} aria-hidden="true" />
                    {state.format === 'pptx'
                        ? t('chat_templates.card_download_pptx', 'Download PowerPoint')
                        : t('chat_templates.card_download_pdf', 'Download PDF')}
                </button>
                <DocumentLinkCard href={state.url} label={t('chat_templates.card_open', 'Open in Documents')} />
            </div>
            {failed && (
                <p role="alert" className="m-0 text-xs text-[var(--text-secondary)]">
                    {t('chat_templates.card_download_failed', 'The download failed. Try again.')}
                </p>
            )}
        </>
    );
}

export default function TemplateFillCard({ toolResults, download = downloadFilledDocument }: { toolResults: unknown; download?: DownloadFn }) {
    const states = templateFillStates(toolResults);
    if (states.length === 0) return null;
    return (
        <div className="not-prose flex flex-col gap-2 my-2">
            {states.map((state) => (
                <div
                    key={state.documentId}
                    data-testid="template-fill-card"
                    className="flex flex-col gap-2 max-w-[420px] p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
                >
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                        <FilePen size={15} className="text-[var(--accent-primary)] shrink-0" aria-hidden="true" />
                        <span className="truncate">{state.name}</span>
                    </div>
                    {state.finished ? <FinishedActions state={state} download={download} /> : <FillProgress state={state} />}
                </div>
            ))}
        </div>
    );
}
