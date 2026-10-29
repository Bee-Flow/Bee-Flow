import { Trash2 } from 'lucide-react';
import { SetStateAction, Dispatch, useEffect, useRef, useState } from 'react';
import ActionChoiceCards from './ActionChoiceCards';
import { EDITOR_BY_KIND, defaultActionForKind } from './actionKindCatalog';
import { stepCount } from './actionRefs';
import AiActionEditor from './AiActionEditors';
import {
    DeleteActionDialog, EditFlowButton, NavigateEditor, OpenUrlEditor, SequenceSummary, SharedActionNote, ToastEditor,
} from './EventWiringParts';
import { INPUT_CLS } from './panels/kit';
import RunAutomationEditor from './RunAutomationEditor';
import { TYPE_EVENT_LISTS } from './styleKnobMeta';
import useEventWiring, { NEW_ACTION } from './useEventWiring';
import useAutomationApi from '@/hooks/useAutomationApi';
import useTranslation from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import FormField from '@/components/shared/FormField';
import IconButton from '@/components/shared/IconButton';
import Modal from '@/components/shared/Modal';
import ActionFlowEditor from '../flow/ActionFlowEditor';
import StepSettings from '../flow/StepSettings';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { WiredAutomation } from './useEventWiring';
import type { AppAction, AppDefinition, AppNode, FormFieldRef, CommonNodeProps } from './appDefinition';
import type { ActionsSectionProps, EventWiringProps } from './ActionsSection.types';

/**
 * ActionsSection — wires each event a node's type supports (styleKnobMeta.
 * TYPE_EVENT_LISTS: button onClick, form onSubmit, data_grid/timeline/calendar
 * onRowClick, data_grid onRowSelect, kanban onCardMove) to an action and edits
 * that action inline. The action vocabulary mirrors ACTION_SPECS in
 * server/appStudio/componentSpecs.js (authoritative):
 *
 *   run_automation { automationId, inputMapping?, onSuccess?, onError? }
 *   navigate       { screenId }
 *   toast          { message, tone? }
 *   open_url       { url, newTab? }
 *
 * A `sequence` is authored on the flow canvas (flow/ActionFlowEditor), which is
 * where every control-flow and data step lives; this section is the entry point
 * to it and the editor for the single-step kinds.
 *
 * inputMapping values: {kind:'static',value} | {kind:'field',name}. Effects
 * are bounded: { toast?: {message,tone}, navigateTo? } — never chains.
 * Every edit commits immediately via setAction/setNodeEvent/removeAction +
 * onCommit(nextDef).
 *
 * An action lives in definition.actions — ONE object that any number of
 * components can point at. Wiring an existing one therefore SHARES it (later
 * edits reach every component using it) and deleting one unhooks all of them,
 * so this section counts the other users of each action, says so before an
 * edit or a delete, and offers a fork ("Only for this one").
 *
 * "Test" fires POST /api/automation/:id/run (see server/routes/automation/
 * runs.js) with the mapping's STATIC values as triggerPayload; the response
 * is { accepted, run, steps } (200), { accepted, pending, message } (202) or
 * { error } — rendered in a capped pre box and forwarded to
 * onTestActionResult(actionId, body).
 */

/**
 * Which event slot is being wired, in the author's words.
 *
 * `onChange` and `onDecided` were missing, so a select's action was headed
 * "When triggered" — a phrase that describes nothing and appears nowhere else
 * in the product. Every event the catalog defines now has a sentence; the
 * lockstep in catalogLockstep.test.js keeps TYPE_EVENT_LISTS honest, and this
 * table has to cover the same set.
 */
const EVENT_LABELS: Record<string, { key: string; en: string; }> = {
    onClick: { key: 'app_studio.inspector.when_clicked', en: 'When clicked' },
    onSubmit: { key: 'app_studio.inspector.when_submitted', en: 'When submitted' },
    onChange: { key: 'app_studio.inspector.when_changed', en: 'When it changes' },
    onRowClick: { key: 'app_studio.inspector.when_row_clicked', en: 'When a row is clicked' },
    onRowSelect: { key: 'app_studio.inspector.when_row_selected', en: 'When a row is selected' },
    onCardMove: { key: 'app_studio.inspector.when_card_moved', en: 'When a card is moved' },
    onDecided: { key: 'app_studio.inspector.when_decided', en: 'When a decision is made' },
};

/**
 * The heading for one event slot. An event with no entry falls back to its own
 * name rather than to "When triggered" — a phrase that says nothing and hid
 * exactly this gap for `onChange`.
 */
function eventLabel(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, event: string) {
    const entry = EVENT_LABELS[event];
    return entry ? t(entry.key, entry.en) : event;
}

// ── Main section ───────────────────────────────────────────────────────────
export default function ActionsSection({ node, definition, onCommit, onTestActionResult, disabled = false, appId = null }: ActionsSectionProps) {
    const events = TYPE_EVENT_LISTS[node?.type ?? ''] || [];
    const actions = definition?.actions || {};
    const api = useAutomationApi();
    const [automations, setAutomations] = useState<WiredAutomation[] | null>(null);
    const fetchedRef = useRef(false);

    // Titles (and agent_call contracts) come from the same list endpoint the
    // Automations sidebar uses — fetched lazily, only when a Run-automation action is
    // actually wired to any of this node's events.
    const hasRunAutomation = events.some((ev) => actions[String(node?.[ev])]?.kind === 'run_automation');
    useEffect(() => {
        if (!hasRunAutomation || fetchedRef.current) return;
        fetchedRef.current = true;
        api.listAutomations<{ automations?: WiredAutomation[] }>()
            .then((r) => setAutomations(r.automations || []))
            .catch(() => setAutomations([]));
    }, [hasRunAutomation, api]);
    const titleFor = (automationId?: string | null) => {
        if (!automationId) return null;
        return (automations || []).find((a) => a.id === automationId)?.title || null;
    };
    if (!events.length) return null;
    return (
        <div className="flex flex-col gap-4">
            {events.map((event, i) => (
                <div key={event} className={i > 0 ? 'pt-4 border-t border-[var(--border-subtle)]' : ''}>
                    <EventWiring
                        event={event}
                        node={node}
                        definition={definition}
                        onCommit={onCommit}
                        onTestActionResult={onTestActionResult}
                        disabled={disabled}
                        automations={automations}
                        setAutomations={setAutomations}
                        titleFor={titleFor}
                        appId={appId}
                    />
                </div>
            ))}
        </div>
    );
}

// ── One event slot's wiring + inline action editor ──────────────────────────

function EventWiring({ event, node, definition, onCommit, onTestActionResult, disabled, automations, setAutomations, titleFor, appId = null }: EventWiringProps) {
    const { t } = useTranslation();
    const wiring = useEventWiring({
        event, node, definition, onCommit, onTestActionResult, automations, setAutomations, titleFor, appId,
    });
    const {
        action, actionId,
        confirmDelete, setConfirmDelete,
        flowFor, setFlowFor,
        confirmFlatten, setConfirmFlatten,
        screens, formFields,
        sharedWith, resultShownBy, choices,
        commitAction, onPickKind, onSelectAction, onForkAction, onDeleteAction, requestDelete,
    } = wiring;

    return (
        <div className="flex flex-col gap-3">
            <EventWiringFormField t={t} event={event} actionId={actionId} onSelectAction={onSelectAction} disabled={disabled} choices={choices} action={action} requestDelete={requestDelete} />

            {action ? (
                <div className="flex flex-col gap-3">
                    {sharedWith.length ? <SharedActionNote sharedWith={sharedWith} onFork={onForkAction} disabled={disabled} /> : null}

                    <ActionChoiceCards kind={action.kind} onPickKind={onPickKind} disabled={disabled}>
                        {/* The way into the step canvas. It lives under "All
                            options" because turning one thing into several is
                            a change of shape, not one of the four choices —
                            but it must always be REACHABLE, or a flow the AI
                            wrote can only be edited by the AI. */}
                        <EditFlowButton onOpen={() => setFlowFor(actionId)} disabled={disabled} />
                    </ActionChoiceCards>

                    {/* The CURRENT state is never hidden behind a disclosure —
                        a five-step flow has to say so where it is read. */}
                    {action.kind === 'sequence' ? (
                        <SequenceSummary action={action} onOpen={() => setFlowFor(actionId)} disabled={disabled} />
                    ) : null}

                    {EDITOR_BY_KIND[action.kind] === 'ai' && (
                        <AiActionEditor action={action} commit={commitAction} formFields={formFields} disabled={disabled} />
                    )}

                    {action.kind === 'run_automation' && (
                        <RunAutomationEditor wiring={wiring} action={action} disabled={disabled} titleFor={titleFor} />
                    )}

                    {action.kind === 'navigate' && (
                        <NavigateEditor action={action} commitAction={commitAction} disabled={disabled} screens={screens} />
                    )}

                    {action.kind === 'toast' && <ToastEditor action={action} commitAction={commitAction} disabled={disabled} />}

                    {action.kind === 'open_url' && <OpenUrlEditor action={action} commitAction={commitAction} disabled={disabled} />}

                    {/* The kinds with no hand-written editor here are edited
                        FROM THE SPEC, the same way the flow canvas edits them.
                        Every kind the schema defines now has an editor; a
                        bespoke one each is a per-kind place for a field to go
                        missing, which is exactly how three of them ended up
                        authorable only by the AI. */}
                    {EDITOR_BY_KIND[action.kind] === 'spec' && (
                        <StepSettings
                            step={action}
                            onChange={commitAction}
                            definition={definition}
                            node={node}
                            screens={definition?.screens || []}
                            formFields={formFields}
                            disabled={disabled}
                        />
                    )}
                </div>
            ) : null}

            {action ? (
                <DeleteActionDialog
                    open={confirmDelete}
                    actionId={actionId}
                    action={action}
                    definition={definition}
                    titleFor={titleFor}
                    sharedWith={sharedWith}
                    resultShownBy={resultShownBy}
                    onConfirm={onDeleteAction}
                    onCancel={() => setConfirmDelete(false)}
                />
            ) : null}

            {/* Switching a real flow back to a single thing throws the rest of
                the steps away — the old code did it on the first change of the
                select, with no warning. */}
            <EventWiringConfirmDialog confirmFlatten={confirmFlatten} t={t} action={action} commitAction={commitAction} definition={definition} formFields={formFields} setConfirmFlatten={setConfirmFlatten} />

            <EventWiringModal flowFor={flowFor} setFlowFor={setFlowFor} t={t} action={action} commitAction={commitAction} definition={definition} node={node} formFields={formFields} disabled={disabled} />
        </div>
    );
}

// The definition reads this section used to hold itself. Re-exported because
// this is the path the inspector's tests reach them through.
export {
     formNameOf, getFormFields,  screenIdOfNode, stepCount,
} from './actionRefs';

function EventWiringConfirmDialog({ confirmFlatten, t, action, commitAction, definition, formFields, setConfirmFlatten }: { confirmFlatten: string | null; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; action: AppAction | null; commitAction: (nextAction: AppAction) => void; definition: AppDefinition; formFields: FormFieldRef[]; setConfirmFlatten: Dispatch<SetStateAction<string | null>>; }) {
    return <ConfirmDialog
        open={!!confirmFlatten}
        title={t('studio_apps_insp.actions.flatten_title', 'Keep only one step?')}
        description={t('studio_apps_insp.actions.flatten_description', 'This flow has {count} steps. Changing it back to a single action keeps none of them.', { count: stepCount(action) })}
        confirmLabel={t('studio_apps_insp.actions.flatten_confirm', 'Discard the other steps')}
        destructive
        onConfirm={() => {
            if (!confirmFlatten) return;
            commitAction(defaultActionForKind(confirmFlatten, definition, formFields));
            setConfirmFlatten(null);
        } }
        onCancel={() => setConfirmFlatten(null)} />;
}

function EventWiringModal({ flowFor, setFlowFor, t, action, commitAction, definition, node, formFields, disabled }: { flowFor: string | null; setFlowFor: Dispatch<SetStateAction<string | null>>; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; action: AppAction | null; commitAction: (nextAction: AppAction) => void; definition: AppDefinition; node: AppNode<CommonNodeProps> | null | undefined; formFields: FormFieldRef[]; disabled: boolean; }) {
    return <Modal
        open={!!flowFor}
        onClose={() => setFlowFor(null)}
        title={t('studio_apps_insp.actions.flow_title', 'What happens, step by step')}
        description={t('studio_apps_insp.actions.flow_description', 'Each step runs in order. A branch runs only the path it takes.')}
        size="full"
    >
        {flowFor ? (
            <div className="h-[70vh]">
                <ActionFlowEditor
                    action={action}
                    onChange={commitAction}
                    definition={definition}
                    node={node}
                    formFields={formFields}
                    disabled={disabled} />
            </div>
        ) : null}
    </Modal>;
}

function EventWiringFormField({ t, event, actionId, onSelectAction, disabled, choices, action, requestDelete }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; event: string; actionId: string | null; onSelectAction: (value: string | null) => void; disabled: boolean; choices: { id: string; label: string; }[]; action: AppAction | null; requestDelete: () => void; }) {
    return <FormField label={eventLabel(t, event)}>
        <div className="flex items-center gap-2">
            <select
                className={INPUT_CLS}
                value={actionId || ''}
                onChange={(e) => onSelectAction(e.target.value)}
                disabled={disabled}
                aria-label={t('studio_apps_insp.actions.action_for', 'Action for {event}', { event })}
            >
                <option value="">{actionId ? t('studio_apps_insp.actions.nothing_happens', 'Nothing happens') : t('studio_apps_insp.actions.choose_what_happens', 'Choose what happens…')}</option>
                <option value={NEW_ACTION}>{t('studio_apps_insp.actions.new_action', 'New action…')}</option>
                {choices.length ? (
                    <optgroup label={t('studio_apps_insp.actions.reuse_group', 'Reuse something this app already does')}>
                        {choices.map((c) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                        ))}
                    </optgroup>
                ) : null}
            </select>
            {action ? (
                <IconButton ariaLabel={t('studio_apps_insp.actions.delete_action', 'Delete action')} onClick={requestDelete} disabled={disabled} variant="danger">
                    <Trash2 />
                </IconButton>
            ) : null}
        </div>
    </FormField>;
}
