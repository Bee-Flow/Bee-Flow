/**
 * One document being filled in from a template, as a form under the chat
 * answer: its name, "10 of 15 fields filled in", every field of its contract
 * (TemplateFillFields), saved as the person types, and the actions: download
 * (PDF, or PowerPoint for a presentation) once nothing required is missing,
 * "Open in Documents", and "Done", which finishes it as template_fill_finish
 * does (refused, with what is missing, while a required field is empty).
 */
import { useState, type ReactNode } from 'react';
import { CheckCircle2, Download, FilePen } from 'lucide-react';

import type { FillDocument, TemplateFillApi } from '@/api/templateFillApi';
import useTranslation from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';
import DocumentLinkCard from '../../documents/DocumentLinkCard';
import TemplateFillFields from './TemplateFillFields';
import { formField } from './templateFillModel';
import useTemplateFillForm, { type LiveOptions, type SaveStatus } from './useTemplateFillForm';

/** Tailwind width steps for the progress bar (a class per tenth, no inline style). */
const WIDTHS = ['w-0', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]', 'w-1/2', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-full'];
const BUTTON = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

function SaveState({ status }: { status: SaveStatus }) {
    const { t } = useTranslation();
    if (status === 'idle') return null;
    const text = status === 'saving' ? t('chat_templates.form_saving', 'Saving…')
        : status === 'saved' ? t('chat_templates.form_saved', 'Saved')
            : t('chat_templates.form_save_failed', 'Not saved. Check your connection and change the field again.');
    return <span role="status" className={`text-xs ${status === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'}`} data-testid="template-fill-save-state">{text}</span>;
}

function Progress({ filled, total }: { filled: number; total: number }) {
    const { t } = useTranslation();
    const step = total > 0 ? Math.round((filled / total) * 10) : 0;
    return (
        <div className="flex items-center gap-2">
            <div className="h-1 flex-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" aria-hidden="true">
                <div className={`h-full bg-[var(--accent-primary)] ${WIDTHS[Math.min(Math.max(step, 0), 10)]}`} />
            </div>
            <p className="m-0 shrink-0 text-xs tabular-nums text-[var(--text-secondary)]" data-testid="template-fill-progress">
                {t('chat_templates.card_progress', '{filled} of {total} fields filled in', { filled, total })}
            </p>
        </div>
    );
}

/** Empty fields the template has a default for: what "Accept all suggestions" fills in. */
function openSuggestions(doc: FillDocument, values: Record<string, unknown>) {
    return doc.fields.filter((f) => f.suggestion !== undefined
        && (values[f.key] === undefined || values[f.key] === null || values[f.key] === ''));
}

function useDownload(doc: FillDocument, api: TemplateFillApi) {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const run = async () => {
        setBusy(true);
        setFailed(false);
        try {
            await api.download(doc.id, doc.name, doc.format);
        } catch (err) {
            logger.debug('filled document download failed', err);
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };
    return { busy, failed, run };
}

export default function TemplateFillForm({ doc, api, live, notes, children }: {
    doc: FillDocument; api: TemplateFillApi;
    /** Filling in together: poll for the others' values (useTemplateFillForm). */
    live?: LiveOptions;
    /** A line per field: who filled it in, who was asked. */
    notes?: Record<string, string>;
    /** Shown above the fields: the colleagues' requests, in a project. */
    children?: ReactNode;
}) {
    const { t } = useTranslation();
    const form = useTemplateFillForm(doc, api, live);
    const download = useDownload(doc, api);
    const { state } = form;
    const readOnly = !doc.editable;
    const suggestions = readOnly ? [] : openSuggestions(doc, form.values);
    return (
        <section
            aria-label={doc.name}
            data-testid="template-fill-card"
            className="flex flex-col max-w-[640px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden"
        >
            <div className="flex flex-col gap-2 px-3 pt-3 pb-2 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    <FilePen size={15} className="text-[var(--accent-primary)] shrink-0" aria-hidden="true" />
                    <span className="truncate" title={doc.name}>{doc.name}</span>
                    {state.finished && <CheckCircle2 size={15} className="text-[var(--success)] shrink-0" aria-label={t('chat_templates.form_finished', 'Finished')} />}
                    <span className="ml-auto shrink-0"><SaveState status={form.status} /></span>
                </div>
                <Progress filled={state.filled} total={state.total} />
            </div>
            <div className="flex flex-col gap-3 px-3 py-3 max-h-[60vh] overflow-y-auto">
                {readOnly
                    ? <p className="m-0 text-xs text-[var(--text-secondary)]">{t('chat_templates.form_read_only', 'You can read this document, but not change it.')}</p>
                    : <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('chat_templates.form_hint', 'Fill in the fields here, or tell the assistant in the chat.')}</p>}
                {suggestions.length > 1 && (
                    <button type="button" data-testid="template-fill-accept-all"
                        onClick={() => suggestions.forEach((f) => form.onChange(f.key, f.suggestion))}
                        className="self-start rounded-md border border-dashed border-[var(--border-default)] px-2 py-1 text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
                        {t('chat_templates.form_accept_all', 'Accept all {count} suggestions', { count: suggestions.length })}
                    </button>
                )}
                {children}
                <TemplateFillFields fields={doc.fields.map(formField)} values={form.values} issues={form.issues} notes={notes} onChange={readOnly ? () => {} : form.onChange} />
                {state.issues.length > 0 && (
                    <ul className="m-0 pl-4 text-xs text-[var(--warning)]" data-testid="template-fill-issues">
                        {state.issues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                )}
            </div>
            {form.refusedFor && form.refusedFor.length > 0 && (
                <p role="alert" className="m-0 px-3 pt-2 text-xs text-[var(--error)]">
                    {t('chat_templates.form_done_missing', 'Still needed before it is done: {fields}', { fields: form.refusedFor.join(', ') })}
                </p>
            )}
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                <button
                    type="button"
                    onClick={download.run}
                    disabled={!state.complete || download.busy}
                    data-testid="template-fill-download"
                    className={`${BUTTON} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`}
                >
                    <Download size={14} aria-hidden="true" />
                    {doc.format === 'pptx'
                        ? t('chat_templates.card_download_pptx', 'Download PowerPoint')
                        : t('chat_templates.card_download_pdf', 'Download PDF')}
                </button>
                <DocumentLinkCard href={doc.url} label={t('chat_templates.card_open', 'Open in Documents')} />
                {!readOnly && !state.finished && (
                    <button type="button" onClick={form.onDone} data-testid="template-fill-done"
                        className={`${BUTTON} border border-[var(--border-subtle)] text-[var(--text-primary)] bg-[var(--bg-primary)]`}>
                        {t('chat_templates.form_done', 'Done')}
                    </button>
                )}
            </div>
            {download.failed && (
                <p role="alert" className="m-0 px-3 pb-2 text-xs text-[var(--text-secondary)]">
                    {t('chat_templates.card_download_failed', 'The download failed. Try again.')}
                </p>
            )}
        </section>
    );
}
