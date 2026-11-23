/**
 * One document being filled in from a template, as a form: the same form under
 * a chat answer, in a project's team chat and in the document editor
 * (components/documents/fill/DocumentFillPanel.tsx puts it in all three).
 *
 * From top to bottom:
 *   - FillHeader: its name, the three steps (fill in, check, done) with the
 *     one it is at, "4 of 8 fields filled in", and whether it is saved;
 *   - FillGuide: the one thing to do next, in a sentence;
 *   - in a project, TeamBlock: what colleagues were asked, the notes for
 *     everyone, and asking a colleague;
 *   - TemplateFillFields: every field of its contract, saved as the person
 *     types, with at each field what belongs to it (FieldExtras): the final
 *     check's remark, who filled it in, notes, "Ask a colleague";
 *   - FillFooter: "Check and finish" (the assistant checks what is filled in
 *     once, then it finishes as template_fill_finish does), download, open,
 *     and where it is kept (a project, and a folder of that project).
 */
import { useRef, type RefObject } from 'react';

import type { FillDocument, TemplateFillApi } from '@/api/templateFillApi';
import useTranslation from '@/hooks/useTranslation';
import { FieldActions, FieldBelow } from '../../documents/fill/FieldExtras';
import FillFooter, { useDownload, type FillPlace } from '../../documents/fill/FillFooter';
import FillGuide, { stageOf } from '../../documents/fill/FillGuide';
import FillHeader from '../../documents/fill/FillHeader';
import { askedOfMe, fieldHints, guideStep } from '../../documents/fill/projectFillModel';
import TeamBlock, { useTeamActions, type FillPeople, type TeamActions } from '../../documents/fill/TeamBlock';
import TemplateFillFields, { type FieldAdornment } from './TemplateFillFields';
import { formField } from './templateFillModel';
import type { TemplateFillField } from './templateFillTypes';
import useTemplateFillForm, { type LiveOptions, type TemplateFillFormState } from './useTemplateFillForm';

export type { FillPlace } from '../../documents/fill/FillFooter';

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Empty fields the template has a default for: what "Accept all suggestions" fills in. */
function openSuggestions(doc: FillDocument, values: Record<string, unknown>) {
    return doc.fields.filter((f) => f.suggestion !== undefined
        && (values[f.key] === undefined || values[f.key] === null || values[f.key] === ''));
}

/** Bring a field into view and put the cursor in it. */
function showField(root: RefObject<HTMLElement | null>, key: string) {
    const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-fill-field]') ?? [])].find((el) => el.dataset.fillField === key);
    if (!row) return;
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    row.querySelector<HTMLElement>('input, textarea, select, button[role="switch"]')?.focus({ preventScroll: true });
}

interface AdornmentInput {
    doc: FillDocument; form: TemplateFillFormState; meId: string | null; people?: FillPeople; actions: TeamActions;
}

/**
 * What the form adds at each field: nothing at a field without a remark, a
 * hint or a note, unless people fill in together (then every field can be
 * asked about and noted on).
 */
function useFieldAdornments({ doc, form, meId, people, actions }: AdornmentInput) {
    const { t } = useTranslation();
    const { team } = form;
    const nameOf = people?.nameOf ?? (() => '');
    const hints = people ? fieldHints({ requests: team.requests, filledBy: team.filledBy, meId }, nameOf, t) : {};
    const remarks = new Map((team.review?.findings ?? []).map((f) => [f.key, f]));
    const readOnly = !doc.editable;
    const together = !!people && !readOnly;
    const adornments = (field: TemplateFillField): FieldAdornment | null => {
        const notes = team.notes.filter((n) => n.key === field.key);
        const remark = remarks.get(field.key);
        const hint = hints[field.key];
        const noting = actions.noting === field.key;
        const below = remark || hint || notes.length > 0 || noting
            ? (
                <FieldBelow fieldKey={field.key} remark={remark} hint={hint} notes={notes} nameOf={nameOf} meId={meId} readOnly={readOnly}
                    noting={noting} onAccept={form.acceptRemark} onDismiss={form.dismissRemark}
                    onAddNote={actions.addNote} onStopNoting={actions.stopNoting} onRemoveNote={actions.removeNote} />
            ) : undefined;
        const fieldActions = together
            ? <FieldActions fieldKey={field.key} canAsk={isBlank(form.values[field.key])} onAsk={actions.ask} onNote={actions.note} />
            : undefined;
        return below || fieldActions ? { actions: fieldActions, below } : null;
    };
    return { adornments, remarked: new Set(remarks.keys()) };
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
    const inEditor = place === 'editor';
    const suggestions = readOnly ? [] : openSuggestions(doc, values);
    const { adornments, remarked } = useFieldAdornments({ doc, form, meId, people, actions });
    const step = guideStep({
        editable: doc.editable, finished: state.finished, missing: state.missingRequired.map((m) => m.key), team, meId, values,
        checkAhead: form.phase === 'check',
    });
    // In the editor the form is the side panel's own content; in a chat it is a card of its own under the answer.
    const frame = inEditor ? 'rounded-lg border border-[var(--border-subtle)]' : 'max-w-[640px] rounded-xl border border-[var(--border-default)] shadow-sm';
    return (
        <section ref={root} aria-label={doc.name} data-testid="template-fill-card" data-phase={form.phase}
            className={`flex flex-col overflow-hidden bg-[var(--bg-primary)] ${frame}`}>
            <FillHeader name={doc.name} showName={!inEditor} finished={state.finished} status={form.status}
                filled={state.filled} total={state.total} stage={stageOf(step)} />
            <div className={`flex flex-col gap-4 px-4 py-3.5 ${inEditor ? '' : 'max-h-[60vh] overflow-y-auto'}`}>
                <FillGuide step={step} context={{ inProject: !!doc.projectId, withAssistant: place === 'chat' }} />
                {people && (
                    <TeamBlock doc={doc} values={values} team={team} meId={meId} people={people} actions={actions} readOnly={readOnly}
                        compact={inEditor} onShow={(key) => showField(root, key)} />
                )}
                {suggestions.length > 1 && (
                    <button type="button" data-testid="template-fill-accept-all"
                        onClick={() => suggestions.forEach((f) => form.onChange(f.key, f.suggestion))}
                        className="self-start rounded-md border border-dashed border-[var(--border-default)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                        {t('chat_templates.form_accept_all', 'Accept all {count} suggestions', { count: suggestions.length })}
                    </button>
                )}
                <TemplateFillFields fields={doc.fields.map(formField)} values={values} issues={form.issues}
                    asked={new Set(askedOfMe(team.requests, meId, values))} remarked={remarked} adornments={adornments} narrow={inEditor}
                    settled={state.finished && !readOnly}
                    onChange={readOnly ? () => {} : form.onChange} />
                {state.issues.length > 0 && (
                    <ul className="m-0 pl-4 text-xs text-[var(--warning)]" data-testid="template-fill-issues">
                        {state.issues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                )}
            </div>
            <FillFooter doc={doc} form={form} place={place} download={download} api={api} onFiled={onFiled} />
        </section>
    );
}
