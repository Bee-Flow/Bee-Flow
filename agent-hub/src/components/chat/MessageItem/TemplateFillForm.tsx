/**
 * One document being filled in from a template, as a form: the same form under
 * a chat answer, in a project's team chat and in the document editor
 * (components/documents/fill/DocumentFillPanel.tsx puts it in all three).
 *
 * From top to bottom: its name and "10 of 15 fields filled in"; the one thing
 * to do next (FillGuide); in a project what colleagues were asked and the notes
 * for everyone (TeamBlock); every field of its contract (TemplateFillFields),
 * saved as the person types, with under each field the final check's remark,
 * who filled it in, notes, and "Ask a colleague" (FieldExtras); and the
 * actions: "Check and finish" (the assistant checks what is filled in once,
 * then it finishes as template_fill_finish does), download (PDF, or
 * PowerPoint for a presentation), open, and where it is kept (SaveToProject:
 * a project, and a folder of that project).
 */
import { useRef, useState, type RefObject } from 'react';
import { CheckCircle2, Download, FilePen, Sparkles } from 'lucide-react';

import type { FillDocument, TemplateFillApi } from '@/api/templateFillApi';
import useTranslation from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';
import DocumentLinkCard from '../../documents/DocumentLinkCard';
import FieldExtras from '../../documents/fill/FieldExtras';
import FillGuide from '../../documents/fill/FillGuide';
import { askedOfMe, fieldHints, guideStep } from '../../documents/fill/projectFillModel';
import SaveToProject from '../../documents/fill/SaveToProject';
import TeamBlock, { useTeamActions, type FillPeople, type TeamActions } from '../../documents/fill/TeamBlock';
import TemplateFillFields from './TemplateFillFields';
import { formField } from './templateFillModel';
import type { TemplateFillField } from './templateFillTypes';
import useTemplateFillForm, { type LiveOptions, type SaveStatus, type TemplateFillFormState } from './useTemplateFillForm';

/** Tailwind width steps for the progress bar (a class per tenth, no inline style). */
const WIDTHS = ['w-0', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]', 'w-1/2', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-full'];
const BUTTON = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
const PRIMARY = `${BUTTON} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`;
const SECONDARY = `${BUTTON} border border-[var(--border-subtle)] text-[var(--text-primary)] bg-[var(--bg-primary)]`;
const LINK = 'rounded px-1 text-xs font-medium text-[var(--accent-primary)] underline focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] disabled:opacity-50';

/** Where the form is shown: under an assistant's answer, or in the document editor (which is the document already). */
export type FillPlace = 'chat' | 'editor';

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

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

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

/** "Check and finish" until the check has run (or cannot), then "Finish"; nothing once it is finished. */
function FinishButton({ form }: { form: TemplateFillFormState }) {
    const { t } = useTranslation();
    if (form.phase === 'done') return null;
    const checking = form.check.busy;
    const label = checking ? t('chat_templates.form_checking', 'Checking…')
        : form.phase === 'finish' ? t('chat_templates.form_finish', 'Finish')
            : t('chat_templates.form_check_finish', 'Check and finish');
    return (
        <button type="button" onClick={() => { void form.onDone(); }} disabled={checking} data-testid="template-fill-done" className={PRIMARY}>
            {form.phase === 'finish' ? <CheckCircle2 size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
            {label}
        </button>
    );
}

/** Once it was checked: a quiet way to let the assistant look again (after changes, say). */
function CheckAgain({ form }: { form: TemplateFillFormState }) {
    const { t } = useTranslation();
    const checked = !!form.team.review && (form.phase === 'finish' || form.phase === 'done');
    if (!checked) return null;
    return (
        <button type="button" onClick={() => { void form.runCheck(); }} disabled={form.check.busy} data-testid="template-fill-check-again" className={LINK}>
            {t('chat_templates.form_check_again', 'Check again')}
        </button>
    );
}

function DownloadButton({ doc, download, complete, primary }: { doc: FillDocument; download: ReturnType<typeof useDownload>; complete: boolean; primary: boolean }) {
    const { t } = useTranslation();
    return (
        <button type="button" onClick={() => { void download.run(); }} disabled={!complete || download.busy} data-testid="template-fill-download"
            className={primary ? PRIMARY : SECONDARY}>
            <Download size={14} aria-hidden="true" />
            {doc.format === 'pptx'
                ? t('chat_templates.card_download_pptx', 'Download PowerPoint')
                : t('chat_templates.card_download_pdf', 'Download PDF')}
        </button>
    );
}

/** The footer: finishing, download, open, and where the document is kept. */
function FillActions({ doc, form, place, download, api, onFiled }: {
    doc: FillDocument; form: TemplateFillFormState; place: FillPlace; download: ReturnType<typeof useDownload>;
    api: TemplateFillApi; onFiled?: (projectId: string) => void;
}) {
    const { filing } = api;
    const canCheck = !!api.review;
    const { t } = useTranslation();
    const editable = doc.editable;
    const inProject = !!doc.projectId;
    // Its owner files a private document; in a project whoever may edit it moves it between the folders.
    const keepable = inProject ? editable : !!doc.canFile;
    return (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)]">
            {editable && <FinishButton form={form} />}
            <DownloadButton doc={doc} download={download} complete={form.state.complete} primary={!editable || form.phase === 'done'} />
            {place === 'chat' && !inProject && <DocumentLinkCard href={doc.url} label={t('chat_templates.card_open', 'Open in Documents')} />}
            {keepable && <SaveToProject documentId={doc.id} projectId={doc.projectId ?? null} filing={filing} onFiled={onFiled} />}
            {editable && canCheck && <CheckAgain form={form} />}
        </div>
    );
}

/** What went wrong or is still in the way, above the buttons. */
function FormAlerts({ form, downloadFailed }: { form: TemplateFillFormState; downloadFailed: boolean }) {
    const { t } = useTranslation();
    return (
        <>
            {form.refusedFor && form.refusedFor.length > 0 && (
                <p role="alert" className="m-0 px-3 pt-2 text-xs text-[var(--error)]">
                    {t('chat_templates.form_done_missing', 'Still needed before it is done: {fields}', { fields: form.refusedFor.join(', ') })}
                </p>
            )}
            {form.check.error !== null && form.phase !== 'done' && (
                <p role="alert" className="m-0 px-3 pt-2 text-xs text-[var(--text-secondary)]" data-testid="template-fill-check-failed">
                    {t('chat_templates.form_check_failed', 'The assistant could not check it now.')} {form.check.error}{' '}
                    {t('chat_templates.form_check_failed_next', 'You can finish without the check.')}
                    <button type="button" onClick={() => { void form.runCheck(); }} disabled={form.check.busy} className={`${LINK} ml-1`}>
                        {t('chat_templates.form_check_retry', 'Try again')}
                    </button>
                </p>
            )}
            {downloadFailed && (
                <p role="alert" className="m-0 px-3 pt-2 text-xs text-[var(--text-secondary)]">
                    {t('chat_templates.card_download_failed', 'The download failed. Try again.')}
                </p>
            )}
        </>
    );
}

/** Bring a field into view and put the cursor in it. */
function showField(root: RefObject<HTMLElement | null>, key: string) {
    const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-fill-field]') ?? [])].find((el) => el.dataset.fillField === key);
    if (!row) return;
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    row.querySelector<HTMLElement>('input, textarea, select, button[role="switch"]')?.focus({ preventScroll: true });
}

interface ExtrasInput {
    doc: FillDocument; form: TemplateFillFormState; meId: string | null; people?: FillPeople; actions: TeamActions;
}

/** What goes under each field: nothing for a field without a remark, a hint or a note, unless people fill in together. */
function useFieldExtras({ doc, form, meId, people, actions }: ExtrasInput) {
    const { t } = useTranslation();
    const { team } = form;
    const nameOf = people?.nameOf ?? (() => '');
    const hints = people ? fieldHints(team.requests, team.filledBy, nameOf, t) : {};
    const remarks = new Map((team.review?.findings ?? []).map((f) => [f.key, f]));
    const readOnly = !doc.editable;
    const extras = (field: TemplateFillField) => {
        const notes = team.notes.filter((n) => n.key === field.key);
        const remark = remarks.get(field.key);
        if (!people && !remark && notes.length === 0) return null;
        return (
            <FieldExtras fieldKey={field.key} remark={remark} hint={hints[field.key]} notes={notes} nameOf={nameOf} meId={meId}
                readOnly={readOnly} together={!!people} empty={isBlank(form.values[field.key])} onAccept={form.acceptRemark} onDismiss={form.dismissRemark}
                onAsk={people ? actions.ask : undefined} onAddNote={actions.addNote} onRemoveNote={actions.removeNote} />
        );
    };
    return { extras, remarked: new Set(remarks.keys()) };
}

export default function TemplateFillForm({ doc, api, live, meId = null, people, place = 'chat', onFiled }: {
    doc: FillDocument; api: TemplateFillApi;
    /** Filling in together: poll for the others' values (useTemplateFillForm). */
    live?: LiveOptions;
    /** Who is reading: their own requests come first and say "you". */
    meId?: string | null;
    /** The people of the project the document is in: with them, colleagues are tagged and notes left. */
    people?: FillPeople;
    place?: FillPlace;
    /** The person's own document was filed into a project from here. */
    onFiled?: (projectId: string) => void;
}) {
    const { t } = useTranslation();
    const form = useTemplateFillForm(doc, api, live);
    const download = useDownload(doc, api);
    const actions = useTeamActions(doc.id, form.setTeam, api.team);
    const root = useRef<HTMLElement>(null);
    const { state, team, values } = form;
    const readOnly = !doc.editable;
    const suggestions = readOnly ? [] : openSuggestions(doc, values);
    const { extras, remarked } = useFieldExtras({ doc, form, meId, people, actions });
    const step = guideStep({
        editable: doc.editable, finished: state.finished, missing: state.missingRequired.map((m) => m.key), team, meId, values,
        checkAhead: form.phase === 'check',
    });
    return (
        <section ref={root} aria-label={doc.name} data-testid="template-fill-card" data-phase={form.phase}
            className={`flex flex-col rounded-xl border border-[var(--border-subtle)] overflow-hidden ${place === 'editor' ? 'bg-[var(--bg-primary)]' : 'max-w-[640px] bg-[var(--bg-secondary)]'}`}>
            <div className="flex flex-col gap-2 px-3 pt-3 pb-2 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    <FilePen size={15} className="text-[var(--accent-primary)] shrink-0" aria-hidden="true" />
                    <span className="truncate" title={doc.name}>{doc.name}</span>
                    {state.finished && <CheckCircle2 size={15} className="text-[var(--success)] shrink-0" aria-label={t('chat_templates.form_finished', 'Finished')} />}
                    <span className="ml-auto shrink-0"><SaveState status={form.status} /></span>
                </div>
                <Progress filled={state.filled} total={state.total} />
            </div>
            <div className={`flex flex-col gap-3 px-3 py-3 ${place === 'chat' ? 'max-h-[60vh] overflow-y-auto' : ''}`}>
                <FillGuide step={step} context={{ inProject: !!doc.projectId, withAssistant: place === 'chat' }} />
                {suggestions.length > 1 && (
                    <button type="button" data-testid="template-fill-accept-all"
                        onClick={() => suggestions.forEach((f) => form.onChange(f.key, f.suggestion))}
                        className="self-start rounded-md border border-dashed border-[var(--border-default)] px-2 py-1 text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
                        {t('chat_templates.form_accept_all', 'Accept all {count} suggestions', { count: suggestions.length })}
                    </button>
                )}
                {people && (
                    <TeamBlock doc={doc} values={values} team={team} meId={meId} people={people} actions={actions} readOnly={readOnly}
                        onShow={(key) => showField(root, key)} />
                )}
                <TemplateFillFields fields={doc.fields.map(formField)} values={values} issues={form.issues}
                    asked={new Set(askedOfMe(team.requests, meId, values))} remarked={remarked} extras={extras} narrow={place === 'editor'}
                    onChange={readOnly ? () => {} : form.onChange} />
                {state.issues.length > 0 && (
                    <ul className="m-0 pl-4 text-xs text-[var(--warning)]" data-testid="template-fill-issues">
                        {state.issues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                )}
            </div>
            <FormAlerts form={form} downloadFailed={download.failed} />
            <FillActions doc={doc} form={form} place={place} download={download} api={api} onFiled={onFiled} />
        </section>
    );
}
