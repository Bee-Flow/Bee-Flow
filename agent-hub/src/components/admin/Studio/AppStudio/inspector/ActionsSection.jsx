import { ExternalLink, FlaskConical, Trash2, Users, Workflow, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import ActionChoiceCards from './ActionChoiceCards';
import { EffectEditor, NavigateParamsEditor, ReturnedEcho, toneOptions } from './ActionEffectEditors';
import { EDITOR_BY_KIND, defaultActionForKind } from './actionKindCatalog';
import { describeAction } from './actionLabels';
import { joinNames, stepCount } from './actionRefs';
import AiActionEditor from './AiActionEditors';
import AutomationTile, { automationHref } from './AutomationTile';
import { ContractDrift, MappingRow } from './MappingRows';
import { INPUT_CLS } from './panels/kit';
import AutomationPicker from './AutomationPicker';
import SentInputsTable from './SentInputsTable';
import { TYPE_EVENT_LISTS } from './styleKnobMeta';
import { SKIP_REASONS } from './testPayload';
import useEventWiring, { NEW_ACTION } from './useEventWiring';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import useTranslation from '../../../../../hooks/useTranslation';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import Disclosure from '../../../../shared/Disclosure';
import FormField from '../../../../shared/FormField';
import IconButton from '../../../../shared/IconButton';
import Modal from '../../../../shared/Modal';
import SegmentedControl from '../../../../shared/SegmentedControl';
import Spinner from '../../../../shared/Spinner';
import Toggle from '../../../../shared/Toggle';
import ActionFlowEditor from '../flow/ActionFlowEditor';
import StepSettings from '../flow/StepSettings';

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
const EVENT_LABELS = {
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
function eventLabel(t, event) {
    const entry = EVENT_LABELS[event];
    return entry ? t(entry.key, entry.en) : event;
}

/**
 * One line saying why a parameter did not travel with the test run.
 *
 * Every reason gets its own sentence: "a file cannot be sent from here" and
 * "that form is not on screen" lead to completely different fixes, and one
 * vague line covering both would send people looking in the wrong place.
 */
function skipSentence(t, entry) {
    const name = entry.field ? `${entry.param} (${entry.field})` : entry.param;
    switch (entry.reason) {
        case SKIP_REASONS.FILE:
            return t(
                'app_studio.inspector.test_skip_file',
                '{name} — a file cannot be sent from here, so the automation runs without it.',
                { name },
            );
        case SKIP_REASONS.NO_SCREEN:
            return t(
                'app_studio.inspector.test_skip_no_screen',
                '{name} — that form is not on the canvas, so there was no value to send.',
                { name },
            );
        case SKIP_REASONS.NO_VALUE:
            return t(
                'app_studio.inspector.test_skip_no_value',
                '{name} — the form has no field by that name, so nothing was sent for it.',
                { name },
            );
        // De automatisering vráágt de parameter, maar er is geen regel die zegt waar
        // hij vandaan komt. Een andere zin dan "nothing is wired to it": daar
        // is er een regel die leeg of onbegrijpelijk is, hier is er geen regel
        // — en dat is precies wat de driftbalk erboven al aanbiedt op te lossen.
        case SKIP_REASONS.NO_MAPPING:
            return t(
                'app_studio.inspector.test_skip_no_mapping',
                '{name} — the automation asks for it but this button has no row for it, so it was left out.',
                { name },
            );
        default:
            return t(
                'app_studio.inspector.test_skip_unmapped',
                '{name} — nothing is wired to it, so it was left out.',
                { name },
            );
    }
}

// ── Main section ───────────────────────────────────────────────────────────

export default function ActionsSection({ node, definition, onCommit, onTestActionResult, disabled = false, appId = null }) {
    const events = TYPE_EVENT_LISTS[node?.type] || [];
    const actions = definition?.actions || {};

    const api = useAutomationApi();
    const [automations, setAutomations] = useState(null);
    const fetchedRef = useRef(false);

    // Titles (and agent_call contracts) come from the same list endpoint the
    // Automations sidebar uses — fetched lazily, only when a Run-automation action is
    // actually wired to any of this node's events.
    const hasRunAutomation = events.some((ev) => actions[node?.[ev]]?.kind === 'run_automation');
    useEffect(() => {
        if (!hasRunAutomation || fetchedRef.current) return;
        fetchedRef.current = true;
        api.listAutomations()
            .then((r) => setAutomations(r.automations || []))
            .catch(() => setAutomations([]));
    }, [hasRunAutomation, api]);

    const titleFor = (automationId) => {
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

function EventWiring({ event, node, definition, onCommit, onTestActionResult, disabled, automations, setAutomations, titleFor, appId = null }) {
    const { t } = useTranslation();
    const {
        action, actionId, automationRows,
        pickerOpen, setPickerOpen,
        confirmDelete, setConfirmDelete,
        test, setTest,
        flowFor, setFlowFor,
        confirmFlatten, setConfirmFlatten,
        confirmTest, setConfirmTest,
        screens, appRef, formFields, formName, targetTrigger, paramMetaByName,
        sharedWith, resultShownBy, choices, structuralSkips, mappingEntries,
        commitAction, onPickKind, onSelectAction, onForkAction, onDeleteAction, requestDelete,
        onPickAutomation, setMapping, renameMapping, removeMapping, addMapping, setEffect, runTest,
    } = useEventWiring({
        event, node, definition, onCommit, onTestActionResult, automations, setAutomations, titleFor, appId,
    });

    return (
        <div className="flex flex-col gap-3">
            <FormField label={eventLabel(t, event)}>
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
            </FormField>

            {action ? (
                <div className="flex flex-col gap-3">
                    {sharedWith.length ? (
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 flex flex-col gap-2">
                            <p className="flex items-start gap-1.5 text-xs text-amber-600">
                                <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>
                                    {sharedWith.length === 1
                                        ? t('studio_apps_insp.actions.shared_with_one', 'This is shared with {count} other component ({names}) — changes affect all of them.', { count: sharedWith.length, names: joinNames(sharedWith) })
                                        : t('studio_apps_insp.actions.shared_with_many', 'This is shared with {count} other components ({names}) — changes affect all of them.', { count: sharedWith.length, names: joinNames(sharedWith) })}
                                </span>
                            </p>
                            <button
                                type="button"
                                onClick={onForkAction}
                                disabled={disabled}
                                className="self-start px-2.5 py-1 text-xs rounded-md border border-amber-500/50 text-amber-600 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
                            >
                                {t('studio_apps_insp.actions.only_this_one', 'Only for this one')}
                            </button>
                        </div>
                    ) : null}

                    <ActionChoiceCards kind={action.kind} onPickKind={onPickKind} disabled={disabled}>
                        {/* The way into the step canvas. It lives under "All
                            options" because turning one thing into several is
                            a change of shape, not one of the four choices —
                            but it must always be REACHABLE, or a flow the AI
                            wrote can only be edited by the AI. */}
                        <button
                            type="button"
                            onClick={() => setFlowFor(actionId)}
                            disabled={disabled}
                            className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        >
                            <Workflow className="w-3.5 h-3.5" aria-hidden="true" />
                            {t('app_studio.inspector.edit_the_flow', 'Edit the flow')}
                        </button>
                    </ActionChoiceCards>

                    {/* The CURRENT state is never hidden behind a disclosure —
                        a five-step flow has to say so where it is read. */}
                    {action.kind === 'sequence' ? (
                        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2.5">
                            <span className="text-xs text-[var(--text-primary)]">
                                {stepCount(action) === 1
                                    ? t('studio_apps_insp.actions.steps_one', '{count} step, run in order.', { count: stepCount(action) })
                                    : t('studio_apps_insp.actions.steps_many', '{count} steps, run in order.', { count: stepCount(action) })}
                            </span>
                            <button
                                type="button"
                                onClick={() => setFlowFor(actionId)}
                                disabled={disabled}
                                className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                            >
                                <Workflow className="w-3.5 h-3.5" aria-hidden="true" /> {t('app_studio.inspector.edit_the_flow', 'Edit the flow')}
                            </button>
                        </div>
                    ) : null}

                    {EDITOR_BY_KIND[action.kind] === 'ai' && (
                        <AiActionEditor action={action} commit={commitAction} formFields={formFields} disabled={disabled} />
                    )}

                    {action.kind === 'run_automation' && (
                        <>
                            <FormField label={t('app_studio.inspector.which_automation', 'Which automation')}>
                                <AutomationTile
                                    automationId={action.automationId || null}
                                    row={action.automationId ? automationRows?.[action.automationId] || null : null}
                                    onChoose={() => setPickerOpen(true)}
                                    onCreate={() => setPickerOpen(true)}
                                    disabled={disabled}
                                    appRef={appRef}
                                />
                            </FormField>

                            <FormField label={t('app_studio.inspector.whats_sent', 'What gets sent')}>
                                <div className="flex flex-col gap-2">
                                    {/* The ANSWER first. Reading "what does this
                                        button send" used to mean parsing three
                                        form controls per parameter. */}
                                    <SentInputsTable
                                        paramMetaByName={paramMetaByName}
                                        inputMapping={action.inputMapping}
                                        formFields={formFields}
                                        showViewerRow={targetTrigger?.kind === 'app_trigger'}
                                    />
                                    {/* Drift stays OUT of the disclosure: what
                                        the automation asks for now, versus what
                                        this action sends, is not an advanced
                                        detail — it is the reason a run fails. */}
                                    <ContractDrift
                                        paramMeta={paramMetaByName}
                                        mapped={mappingEntries.map(([p]) => p)}
                                        onAdd={(name) => setMapping(name, { kind: 'static', value: '' })}
                                        onRemove={removeMapping}
                                        disabled={disabled}
                                    />
                                    <Disclosure title={t('app_studio.inspector.change_whats_sent', 'Change what gets sent')}>
                                        <div className="flex flex-col gap-2">
                                            {mappingEntries.map(([param, mapping], i) => (
                                                // Keyed by POSITION: the param name is
                                                // the value being typed, so keying on it
                                                // remounts the row on every keystroke.
                                                <MappingRow
                                                    key={i}
                                                    param={param}
                                                    mapping={mapping}
                                                    formFields={formFields}
                                                    paramMeta={paramMetaByName?.[param] || null}
                                                    takenNames={mappingEntries.map(([p]) => p).filter((p) => p !== param)}
                                                    onChange={(v) => setMapping(param, v)}
                                                    onRename={(v) => renameMapping(param, v)}
                                                    onRemove={() => removeMapping(param)}
                                                    disabled={disabled}
                                                />
                                            ))}
                                            <button
                                                type="button"
                                                onClick={addMapping}
                                                disabled={disabled}
                                                className="px-3 py-1.5 text-xs rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-50"
                                            >
                                                {t('studio_apps_insp.actions.add_parameter', '+ Add parameter')}
                                            </button>
                                        </div>
                                    </Disclosure>
                                </div>
                            </FormField>

                            <FormField label={t('app_studio.inspector.whats_returned', 'What comes back')}>
                                <div className="flex flex-col gap-2">
                                    <ReturnedEcho action={action} screens={screens} />
                                    <Disclosure title={t('app_studio.inspector.all_options', 'All options')}>
                                        <div className="flex flex-col gap-2">
                                            <EffectEditor
                                                label={t('studio_apps_insp.actions.on_success', 'On success')}
                                                effect={action.onSuccess}
                                                screens={screens}
                                                onChange={(e) => setEffect('onSuccess', e)}
                                                disabled={disabled}
                                            />
                                            <EffectEditor
                                                label={t('studio_apps_insp.actions.on_error', 'On error')}
                                                effect={action.onError}
                                                screens={screens}
                                                onChange={(e) => setEffect('onError', e)}
                                                disabled={disabled}
                                            />
                                        </div>
                                    </Disclosure>
                                </div>
                            </FormField>

                            <button
                                type="button"
                                onClick={() => setConfirmTest(true)}
                                disabled={disabled || !action.automationId || test?.status === 'running'}
                                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {test?.status === 'running' ? <Spinner size="xs" /> : <FlaskConical className="w-4 h-4" />}
                                {t('app_studio.inspector.test_with_screen', 'Test with what is on screen')}
                            </button>
                            <p className="-mt-1 text-xs text-[var(--text-secondary)]">
                                {formName
                                    ? t(
                                        'app_studio.inspector.test_caption',
                                        'Runs the automation for real, with the values standing in this form right now, and opens the run in the builder.',
                                    )
                                    : t(
                                        'app_studio.inspector.test_caption_no_form',
                                        'Runs the automation for real and opens the run in the builder. This button is not in a form, so there are no screen values to send.',
                                    )}
                            </p>
                            {/* What can never travel, said BEFORE the click.
                                Someone who tests with half the input and does
                                not know it draws the wrong conclusion about
                                the automation. */}
                            {structuralSkips.length ? (
                                <ul className="-mt-1 flex flex-col gap-0.5 text-xs text-amber-600">
                                    {structuralSkips.map((s) => (
                                        <li key={`always-${s.param}`}>{skipSentence(t, s)}</li>
                                    ))}
                                </ul>
                            ) : null}
                            <ConfirmDialog
                                open={confirmTest}
                                title={t('studio_apps_insp.actions.run_now_title', 'Run “{name}” now?', { name: titleFor(action.automationId) || t('studio_apps_insp.actions.this_automation', 'this automation') })}
                                description={t('studio_apps_insp.actions.run_now_description', 'This is the real run, not a rehearsal — anything it sends or writes actually happens.')}
                                confirmLabel={t('studio_apps_insp.actions.run_it', 'Run it')}
                                onConfirm={runTest}
                                onCancel={() => setConfirmTest(false)}
                            />

                            {test && test.status !== 'running' && (
                                <div className="rounded-md border border-[var(--border-subtle)] overflow-hidden">
                                    <div className="flex items-center justify-between px-2.5 py-1.5 bg-[var(--bg-tertiary)]">
                                        <span className={`text-[11px] font-semibold uppercase tracking-wide ${test.status === 'error' ? 'text-rose-500' : 'text-emerald-500'}`}>
                                            {test.status === 'error' ? t('studio_apps_insp.actions.test_failed', 'Test failed') : t('studio_apps_insp.actions.test_result', 'Test result')}
                                        </span>
                                        <IconButton ariaLabel={t('studio_apps_insp.actions.dismiss_test_result', 'Dismiss test result')} onClick={() => setTest(null)} size="sm">
                                            <X />
                                        </IconButton>
                                    </div>
                                    {/* The way to the run itself, always an
                                        ordinary link: openRunInBuilder already
                                        tried a tab, and a blocked pop-up must
                                        not be the end of the road. */}
                                    <div className="flex flex-col gap-1 px-2.5 pt-2">
                                        <a
                                            href={automationHref(action.automationId, appRef, { view: 'runs', runId: test.runId || null })}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 self-start text-xs font-medium text-[var(--accent-primary)] hover:underline"
                                        >
                                            {test.runId
                                                ? t('app_studio.inspector.test_open_run', 'Open this run in the builder')
                                                : t('app_studio.inspector.test_open_runs', 'Open this automation’s runs in the builder')}
                                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                        </a>
                                        {/* And what the run did NOT get. Said
                                            again here because the reasons that
                                            depend on the moment (a form that
                                            was not on screen) can only be known
                                            once it has been pressed. */}
                                        {test.skipped?.length ? (
                                            <ul className="flex flex-col gap-0.5 text-xs text-amber-600">
                                                {test.skipped.map((s) => (
                                                    <li key={`sent-${s.param}`}>{skipSentence(t, s)}</li>
                                                ))}
                                            </ul>
                                        ) : null}
                                    </div>
                                    <pre className="text-xs p-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                                        {test.status === 'error' ? test.error : JSON.stringify(test.body, null, 2)}
                                    </pre>
                                </div>
                            )}

                            <AutomationPicker
                                open={pickerOpen}
                                onClose={() => setPickerOpen(false)}
                                onPick={onPickAutomation}
                                formFields={formFields}
                                appRef={appRef}
                            />
                        </>
                    )}

                    {action.kind === 'navigate' && (
                        <>
                            <FormField label={t('studio_apps_insp.actions.screen', 'Screen')}>
                                <select
                                    className={INPUT_CLS}
                                    value={action.screenId || ''}
                                    onChange={(e) => commitAction({ ...action, screenId: e.target.value })}
                                    disabled={disabled}
                                    aria-label={t('studio_apps_insp.actions.target_screen', 'Target screen')}
                                >
                                    {screens.map((s) => (
                                        <option key={s.id} value={s.id}>{s.name || s.id}</option>
                                    ))}
                                </select>
                            </FormField>
                            <NavigateParamsEditor
                                params={action.params}
                                onChange={(params) => {
                                    const { params: _drop, ...rest } = action;
                                    commitAction(params ? { ...rest, params } : rest);
                                }}
                                disabled={disabled}
                            />
                        </>
                    )}

                    {action.kind === 'toast' && (
                        <>
                            <FormField label={t('studio_apps_insp.actions.message', 'Message')}>
                                <input
                                    type="text"
                                    className={INPUT_CLS}
                                    value={action.message || ''}
                                    onChange={(e) => commitAction({ ...action, message: e.target.value })}
                                    placeholder={t('studio_apps_insp.actions.message_placeholder', 'What should the message say?')}
                                    disabled={disabled}
                                />
                            </FormField>
                            <FormField label={t('studio_apps_insp.actions.tone', 'Tone')}>
                                <SegmentedControl
                                    value={action.tone || 'info'}
                                    onChange={(tone) => commitAction({ ...action, tone })}
                                    options={toneOptions(t)}
                                    size="sm"
                                    fullWidth
                                    disabled={disabled}
                                    ariaLabel={t('studio_apps_insp.actions.message_tone', 'Message tone')}
                                />
                            </FormField>
                        </>
                    )}

                    {action.kind === 'open_url' && (
                        <>
                            <FormField label={t('studio_apps_insp.actions.url', 'URL')} hint={t('studio_apps_insp.actions.url_hint', 'Must be an https URL.')}>
                                <input
                                    type="text"
                                    className={INPUT_CLS}
                                    value={action.url || ''}
                                    onChange={(e) => commitAction({ ...action, url: e.target.value })}
                                    placeholder={t('studio_apps_insp.actions.url_placeholder', 'https://…')}
                                    disabled={disabled}
                                    spellCheck={false}
                                />
                            </FormField>
                            <Toggle
                                label={t('studio_apps_insp.actions.open_new_tab', 'Open in a new tab')}
                                checked={action.newTab !== false}
                                onChange={(v) => commitAction({ ...action, newTab: v })}
                                disabled={disabled}
                                size="sm"
                            />
                        </>
                    )}

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
            <ConfirmDialog
                open={confirmDelete}
                title={t('studio_apps_insp.actions.delete_title', 'Delete “{name}”?', { name: describeAction(actionId, action, definition, titleFor, t) })}
                description={(
                    <>
                        {sharedWith.length ? (
                            <>{t('studio_apps_insp.actions.delete_shared', 'It stops happening on {names} too.', { names: joinNames(sharedWith) })} </>
                        ) : null}
                        {resultShownBy.length ? (
                            <>{resultShownBy.length === 1
                                ? t('studio_apps_insp.actions.delete_result_one', '{names} shows what it produced, and will be left empty.', { names: joinNames(resultShownBy) })
                                : t('studio_apps_insp.actions.delete_result_many', '{names} show what it produced, and will be left empty.', { names: joinNames(resultShownBy) })} </>
                        ) : null}
                        {t('studio_apps_insp.actions.cannot_undo', "This can't be undone.")}
                    </>
                )}
                confirmLabel={t('studio_apps_insp.actions.delete_everywhere', 'Delete everywhere')}
                destructive
                onConfirm={onDeleteAction}
                onCancel={() => setConfirmDelete(false)}
            />
            ) : null}

            {/* Switching a real flow back to a single thing throws the rest of
                the steps away — the old code did it on the first change of the
                select, with no warning. */}
            <ConfirmDialog
                open={!!confirmFlatten}
                title={t('studio_apps_insp.actions.flatten_title', 'Keep only one step?')}
                description={t('studio_apps_insp.actions.flatten_description', 'This flow has {count} steps. Changing it back to a single action keeps none of them.', { count: stepCount(action) })}
                confirmLabel={t('studio_apps_insp.actions.flatten_confirm', 'Discard the other steps')}
                destructive
                onConfirm={() => {
                    commitAction(defaultActionForKind(confirmFlatten, definition, formFields));
                    setConfirmFlatten(null);
                }}
                onCancel={() => setConfirmFlatten(null)}
            />

            <Modal
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
                            disabled={disabled}
                        />
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}

// The definition reads this section used to hold itself. Re-exported because
// this is the path the inspector's tests reach them through.
export {
    enclosingForm, formNameOf, getFormFields, getFormFieldNames, screenIdOfNode, stepCount,
} from './actionRefs';
