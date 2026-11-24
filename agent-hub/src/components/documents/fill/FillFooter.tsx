/**
 * The bottom of a fill-in form: what is still in the way (said in words), and
 * the actions. One main button that moves the form on, "Check and finish"
 * until the assistant's check has run (or cannot), then "Finish"; and beside
 * it, all in one quiet style: download (PDF, or PowerPoint for a
 * presentation), in a chat a preview of the document as it stands
 * (PreviewButton) and opening it, and where it is kept (SaveToProject).
 */
import { useState } from 'react';
import { CheckCircle2, Download, ExternalLink, Sparkles } from 'lucide-react';

import type { FillDocument, TemplateFillApi } from '@/api/templateFillApi';
import { openLibraryDocument } from '@/components/chat/MessageItem/openLibraryDocument';
import type { TemplateFillFormState } from '@/components/chat/MessageItem/useTemplateFillForm';
import useTranslation from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';
import PreviewButton from './PreviewButton';
import SaveToProject from './SaveToProject';
import { FILL_LINK, FILL_PRIMARY, FILL_SECONDARY } from './fillStyles';

/** Where the form is shown: under an assistant's answer, or in the document editor (which is the document already). */
export type FillPlace = 'chat' | 'editor';

export function useDownload(doc: FillDocument, api: TemplateFillApi) {
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

type DownloadState = ReturnType<typeof useDownload>;

/** Open the document where its readers work on it: a project's document in its project, a person's own beside the chat. */
function openDocument(doc: FillDocument) {
    if (!doc.projectId) { openLibraryDocument(doc.id); return; }
    window.history.pushState({ page: 'projects' }, '', doc.url);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'projects' } }));
}

/**
 * "Check and finish" until the check has run (or cannot), then "Finish"; nothing once it is finished. While
 * required fields are still empty it is there but quiet (pressing it says what is missing): the thing to do then
 * is in the fields, not down here.
 */
function FinishButton({ form }: { form: TemplateFillFormState }) {
    const { t } = useTranslation();
    if (form.phase === 'done') return null;
    const checking = form.check.busy;
    const label = checking ? t('chat_templates.form_checking', 'Checking…')
        : form.phase === 'finish' ? t('chat_templates.form_finish', 'Finish')
            : t('chat_templates.form_check_finish', 'Check and finish');
    return (
        <button type="button" onClick={() => { void form.onDone(); }} disabled={checking} data-testid="template-fill-done"
            className={form.phase === 'fill' ? FILL_SECONDARY : FILL_PRIMARY}>
            {form.phase === 'finish' ? <CheckCircle2 size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
            {label}
        </button>
    );
}

/** Shown once nothing required is missing: before that there is no document to download yet. */
function DownloadButton({ doc, download, primary }: { doc: FillDocument; download: DownloadState; primary: boolean }) {
    const { t } = useTranslation();
    return (
        <button type="button" onClick={() => { void download.run(); }} disabled={download.busy} data-testid="template-fill-download"
            className={primary ? FILL_PRIMARY : FILL_SECONDARY}>
            <Download size={15} aria-hidden="true" />
            {doc.format === 'pptx'
                ? t('chat_templates.card_download_pptx', 'Download PowerPoint')
                : t('chat_templates.card_download_pdf', 'Download PDF')}
        </button>
    );
}

/** Once it was checked: a quiet way to let the assistant look again (after changes, say). */
function CheckAgain({ form }: { form: TemplateFillFormState }) {
    const { t } = useTranslation();
    const checked = !!form.team.review && (form.phase === 'finish' || form.phase === 'done');
    if (!checked) return null;
    return (
        <button type="button" onClick={() => { void form.runCheck(); }} disabled={form.check.busy} data-testid="template-fill-check-again" className={`${FILL_LINK} sm:ml-auto`}>
            {t('chat_templates.form_check_again', 'Check again')}
        </button>
    );
}

/** What went wrong or is still in the way, above the buttons. */
function FormAlerts({ form, downloadFailed }: { form: TemplateFillFormState; downloadFailed: boolean }) {
    const { t } = useTranslation();
    const refused = form.refusedFor && form.refusedFor.length > 0;
    const checkFailed = form.check.error !== null && form.phase !== 'done';
    if (!refused && !checkFailed && !downloadFailed) return null;
    return (
        <div className="flex flex-col gap-1.5 text-xs">
            {refused && (
                <p role="alert" className="m-0 text-[var(--error)]">
                    {t('chat_templates.form_done_missing', 'Still needed before it is done: {fields}', { fields: (form.refusedFor ?? []).join(', ') })}
                </p>
            )}
            {checkFailed && (
                <p role="alert" className="m-0 text-[var(--text-secondary)]" data-testid="template-fill-check-failed">
                    {t('chat_templates.form_check_failed', 'The assistant could not check it now.')} {form.check.error}{' '}
                    {t('chat_templates.form_check_failed_next', 'You can finish without the check.')}
                    <button type="button" onClick={() => { void form.runCheck(); }} disabled={form.check.busy} className={`${FILL_LINK} ml-1`}>
                        {t('chat_templates.form_check_retry', 'Try again')}
                    </button>
                </p>
            )}
            {downloadFailed && <p role="alert" className="m-0 text-[var(--text-secondary)]">{t('chat_templates.card_download_failed', 'The download failed. Try again.')}</p>}
        </div>
    );
}

export default function FillFooter({ doc, form, place, download, api, onFiled }: {
    doc: FillDocument; form: TemplateFillFormState; place: FillPlace; download: DownloadState;
    api: TemplateFillApi; onFiled?: (projectId: string) => void;
}) {
    const { t } = useTranslation();
    const editable = doc.editable;
    const inProject = !!doc.projectId;
    // Its owner files a private document; in a project whoever may edit it moves it between the folders.
    const keepable = inProject ? editable : !!doc.canFile;
    // In the editor's narrow column the buttons are one under the other, each the full width.
    const narrow = place === 'editor';
    return (
        <div className="flex flex-col gap-2.5 border-t border-[var(--border-subtle)] px-4 py-3">
            <FormAlerts form={form} downloadFailed={download.failed} />
            <div className={`flex gap-2 ${narrow ? 'flex-col items-stretch' : 'flex-wrap items-center'}`} data-testid="template-fill-actions">
                {editable && <FinishButton form={form} />}
                {form.state.complete && <DownloadButton doc={doc} download={download} primary={!editable || form.phase === 'done'} />}
                {/* The editor shows the same page next to the form; a presentation has its own viewer. */}
                {place === 'chat' && api.preview && doc.format === 'pdf' && <PreviewButton doc={doc} load={api.preview} flush={form.flush} />}
                {place === 'chat' && (
                    <button type="button" onClick={() => openDocument(doc)} data-testid="template-fill-open" className={FILL_SECONDARY}
                        title={inProject ? t('chat_templates.card_open_project', 'Open in the project') : t('chat_templates.card_open', 'Open in Documents')}>
                        <ExternalLink size={15} aria-hidden="true" />{t('chat_templates.card_open_short', 'Open')}
                    </button>
                )}
                {keepable && <SaveToProject documentId={doc.id} projectId={doc.projectId ?? null} filing={api.filing} onFiled={onFiled} />}
                {editable && !!api.review && <CheckAgain form={form} />}
            </div>
        </div>
    );
}
