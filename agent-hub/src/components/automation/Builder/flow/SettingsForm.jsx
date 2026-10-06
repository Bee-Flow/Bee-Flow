import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isPrivacyStep } from './privacyModel';
import { isRouteStep } from './routeModel';
import { sectionsWithErrors } from './sectionForIssue';
import {
    IntegrationActionFields, LoopFields, CodeFields, NotificationFields, GenerateDocumentFields,
    FillDocumentFields, SlideFields, PresentationFields,
    DataExtractionFields,
    HttpRequestFields, CallLayerFields, CallStepFields, LayerOutputFields, StopErrorFields,
    findActionAndSiblings,
} from './settings/actionEditors';
import { emptySlotsIn } from '../mapping/boundPaths';
import { listAsForStepType, SlotListAsContext } from '../mapping/slotListAs';
import { AiStepFields } from './settings/aiStepEditors';
import { ApprovalFields } from './settings/approvalEditors';
import {
    DateTimeFields, WaitFields, LimitFields, DedupeFields, AggregateFields, SummarizeFields,
} from './settings/collectionEditors';
import DatatableFields from './settings/datatableEditors';
import { sampleFromRunOf } from './settings/flattenEditorModel';
import FlattenFields from './settings/FlattenFields';
import { useFormDensity, useFormMode } from './settings/formDensity';
import { inputClass, controlSurfaceClass, hintTextClass, FormRow, ValidationLine } from './settings/formPrimitives';
import { defaultLabelPlaceholder, extractFormState, buildPatch, deepEqual, carryPendingRows } from './settings/formState';
import JsonConfigSection from './settings/JsonConfigEditor';
import KnowledgeWriteFields from './settings/knowledgeWriteEditors';
import ParseJsonFields from './settings/ParseJsonFields';
import { PrivacyShieldFields } from './settings/privacyEditors';
import ReturnToAppFields from './settings/returnToAppEditor';
import { RouteFields } from './settings/routeEditors';
import { SetFields } from './settings/setEditors';
import { TriggerFields, FormPageFields } from './settings/triggerEditors';
import { IconPicker } from './stepIcons';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * Whether the Condition node may offer "is about" (the topic classifier), read
 * from the builder catalog: `{ available, reason }`, or null when the server
 * does not say (an older server), in which case the operator is not offered.
 */
function topicsCapability(catalog) {
    const flags = catalog?.flags;
    if (!flags || typeof flags.topics !== 'boolean') return null;
    return { available: flags.topics, reason: flags.topicsReason || null };
}
export { schemaToFields, fieldsToSchema } from './settings/formState';

/**
 * Per-step-type form-based editor. Each subcomponent owns its own draft
 * state, computes a patch on Save, and dispatches via `onPatch(patch)`
 * which the inspector merges onto the existing step. Reset reverts to
 * whatever is currently persisted in the step.
 *
 * Field coverage by type:
 *   trigger             — label, kind, schedule (cron/tz), Gmail mail.new filter
 *   integration_action  — label, inputs (key/kind/value editor), tool (read-only)
 *   ai_step             — label, prompt, systemPrompt, modelTier, allowTools, inputs
 *   condition           — label, expr
 *   loop                — label, overRef, itemVar, maxIterations
 *   code                — label, code source
 *   notification        — label, title, body
 *
 * Validation banner + Save/Reset live at the bottom of the form so every
 * type shares the same chrome.
 */
export default function SettingsForm({
    step, modelTiers, stepIssues, saving, saveError, onPatch,
    onFocusField = null, previewSample = null, catalog = null, groups = [],
    // Whole automation document (incl. the root-only `layers` map).
    // Needed by CallLayerFields to derive a flowlet's live contract — the
    // scoped `definition` the inspector binds against has no layers map.
    rootDefinition = null,
    // The persisted automation row. Only the webhook trigger uses it, to show
    // that node's inbound URL inline instead of burying it in Settings
    // (BFSF-320). Null until the automation has been saved once.
    automation = null,
    // Published Steps catalog [{id,title,params,outputFields}] — CallStepFields
    // derives an external Step's contract from this (the Step lives in another
    // row, so there's no local layers entry to read).
    blocksCatalog = [],
    // For a switch node: the case names that currently have an outgoing edge
    // on the canvas (NodeDetailView derives it from definition.edges). The
    // Cases editor uses it to tell the user a rename keeps the connection and
    // a removal drops it (node-audit B1).
    wiredCaseNames = null,
    // This step's outgoing edges — the Privacy Shield mode selector needs them
    // to say which connections a mode switch would cost before it happens.
    stepEdges = [],
    // True when the edited node lives in definition.triggers[] (a SECONDARY
    // trigger) — only webhook/app_event are legal there, so the kind <select>
    // must not offer the four kinds the validator hard-rejects (C7).
    isSecondaryTrigger = false,
    // (answers) => Promise — supplied ONLY by the NDV on a form TRIGGER, and
    // only where a run can actually be started. It makes the form preview below
    // submittable: the answers become the run's triggerPayload (BFSF-408a).
    // Absent everywhere else, which is what keeps the identical preview on a
    // `form_page` step inert.
    onTestSubmit = null,
    // Renaming a form question's binding name rewrites the whole definition, so
    // it is handed down from the shell that owns it — see FormBuilderFields.
    onRenameField = null,
    // (step) => boolean|undefined — insert a step BEFORE this one and re-point
    // the connections. Same shape and same reason as onRenameField above: it
    // rewrites the graph, so it comes from the shell that owns the definition,
    // and the control that offers it is simply not rendered when it is null
    // (Condition node → RouteFields → RouteAssist's semantic handoff).
    onInsertUpstreamStep = null,
    // A Condition working through a list: the next steps that still read that
    // list, and the fix that re-points them (useNodeDetailData's routeFollow;
    // null everywhere else). Same reason as above: the fix rewrites the graph.
    routeFollow = null,
    // A Condition deciding once for the whole run that reads a list as a
    // whole: the lists and the loops after it (useNodeDetailData's wholeRun).
    wholeRun = null,
    // Optional host content for the left of the action bar. The quick NDV puts
    // its "In … → Out …" summary here so the dialog ends in one footer instead
    // of stacking a second chrome bar underneath this one. Null everywhere
    // else, including the SettingsForm nested inside a loop body.
    footerLeft = null,
    // The small dialog's footer has room for one line and no more, so it drops
    // the autosave note that the full drawer keeps. Density, not content: the
    // note is still true in both.
    compactFooter = false,
    // (stepId) => void — open this step's contents on the canvas instead.
    // Only a Loop uses it today; supplied by BuildTab, absent everywhere the
    // canvas is not in view (the nested form inside LoopBodyEditor, tests), and
    // the button is simply not rendered then.
    onExpandOnCanvas = null,
    // This step's latest recorded run row, when there is one (the NDV has it).
    // Edit data reads it to tell a source list that no longer resolves from
    // one that is fine (BFSF-363). Null everywhere else.
    runStep = null,
}) {
    // Baseline ref tracks "what the server has". We diverge from baseline
    // when the user edits; we resync whenever the parent passes back step
    // content that matches a patch we just sent (= save round-tripped).
    //
    // The parent keys SettingsForm by step.id, so switching steps unmounts
    // this instance (with its closures over the OUTGOING step intact) and
    // mounts a fresh one — no in-component step-id transition to handle.
    const [baseline, setBaseline] = useState(() => extractFormState(step));
    const baselineRef = useRef(baseline);
    useEffect(() => { baselineRef.current = baseline; }, [baseline]);
    const [draft, setDraft] = useState(() => extractFormState(step));

    // Latest-state refs so the unmount flusher always sees the current
    // step+draft. Closures captured at mount would be stale.
    const onPatchRef = useRef(onPatch);
    const stepRef = useRef(step);
    const draftRef = useRef(draft);
    useEffect(() => { onPatchRef.current = onPatch; stepRef.current = step; draftRef.current = draft; });

    const dirty = useMemo(() => !deepEqual(draft, baseline), [draft, baseline]);
    const { density } = useFormDensity();
    const formMode = useFormMode();
    const { t } = useTranslation();

    // Which accordion sections hold a validation error — those are forced
    // open so an error is never hidden behind a collapsed section. Cheap
    // enough to compute each render (the React Compiler memoizes it).
    const errorSections = sectionsWithErrors(step, stepIssues);

    // The footer's "1 field still empty" count. Read off the DRAFT (what is on
    // screen), merged onto the step so a slot the draft does not carry — a
    // required tool parameter nobody has touched — still counts. The tool's
    // schema is resolved the same way the Inputs editor resolves it, so the
    // two always agree on which parameters are required.
    const emptySlots = useMemo(() => {
        const tool = draft.tool || step?.tool;
        const inputSchema = tool
            ? findActionAndSiblings(catalog, tool, draft.appId || step?.appId).action?.inputSchema || null
            : null;
        // A tool step whose schema did NOT resolve is a step this count cannot
        // finish: the required parameters are exactly the slots that leave no
        // trace when unfilled. That happens for real — the catalog fetch is
        // fire-and-forget on both sites (BuildTab, NodeDetailView) and stays
        // null for the session after a 401 — and counted silently it reads as
        // "nothing wrong". The footer says so instead.
        const schemaKnown = !tool || !!inputSchema;
        return emptySlotsIn({ ...step, ...draft }, { inputSchema, schemaKnown });
    }, [step, draft, catalog]);

    // Same-id content sync: when the parent re-renders with new step
    // content (e.g. server confirmed our last save, or chat updated the
    // label), adopt the incoming state IF the user has no local edits.
    // If the user IS mid-edit, just slide baseline forward so `dirty`
    // stays accurate against the new server state — the user's edits
    // remain in `draft` and the next autosave reconciles.
    //
    // We read `draft` via `draftRef.current` rather than including `draft`
    // in deps: this effect must only react to step-content changes, not
    // every keystroke. The ref read is intentional (not a dep), so we
    // declare the dep array explicitly with just `step`.
    useEffect(() => {
        const incoming = extractFormState(step);
        if (deepEqual(incoming, baselineRef.current)) return;
        const userHasEdits = !deepEqual(draftRef.current, baselineRef.current);
        baselineRef.current = incoming;
        setBaseline(incoming);
        // Adopt the incoming content, but never erase a row the user just
        // added and has not filled in yet — a blank document binding, an
        // approver seat naming nobody, a stage with no approvers. Those rows
        // exist only in the draft (buildPatch rightly drops them from every
        // save), so a save echo never carries them back; adopting the echo
        // verbatim is what made "Add a document" vanish a second after the
        // click.
        if (!userHasEdits) setDraft(carryPendingRows(incoming, draftRef.current));
    }, [step]);

    // A function value is an updater on the current value (and the whole
    // draft), for edits that must land after another one in the same event.
    const set = (k, v) => setDraft(d => ({ ...d, [k]: typeof v === 'function' ? v(d[k], d) : v }));
    const setNested = (parent, k, v) => setDraft(d => ({ ...d, [parent]: { ...(d[parent] || {}), [k]: v } }));

    const flushNow = () => {
        if (deepEqual(draftRef.current, baselineRef.current)) return false;
        const sending = draftRef.current;
        const patch = buildPatch(stepRef.current, sending);
        // The draft can be ahead of the baseline in ways the wire cannot
        // say — pending rows buildPatch drops (a blank attachment binding, an
        // empty approver seat, a seatless stage). When the patch it builds is
        // the very patch the baseline would build, there is nothing to tell
        // the server: advance the baseline locally and keep the pending rows
        // where they are. Saving anyway is what used to erase them — the
        // save's echo came back without the row, read as fresh content over
        // an edit-free draft, and the content sync adopted it.
        if (deepEqual(patch, buildPatch(stepRef.current, baselineRef.current))) {
            baselineRef.current = sending;
            setBaseline(sending);
            return false;
        }
        // Advance baseline only on success. If the PUT fails the form
        // stays dirty so autosave (or manual Save) can retry. Concurrent
        // flushes are coalesced upstream in StepInspector.persistStepPatch.
        Promise.resolve(onPatchRef.current?.(patch))
            .then(() => { baselineRef.current = sending; setBaseline(sending); })
            .catch(() => {});
        return true;
    };

    const onSave = async () => {
        if (deepEqual(draft, baseline)) return;
        const sending = draft;
        const patch = buildPatch(step, sending);
        try {
            await onPatch(patch);
            baselineRef.current = sending;
            setBaseline(sending);
        } catch {
            // Leave baseline alone — dirty stays true, user can retry.
        }
    };

    const reset = () => setDraft(baseline);

    // Debounced auto-save — 600ms after user stops typing. After a save
    // failure we back off to 5s so a broken network doesn't get hammered
    // 100 times/min; the user can still hit the manual Save button to
    // retry immediately, and a new keystroke also restarts the timer.
    useEffect(() => {
        if (!dirty || saving) return;
        const delay = saveError ? 5000 : 600;
        const t = setTimeout(() => { flushNow(); }, delay);
        return () => clearTimeout(t);
    }, [draft, dirty, saving, saveError]);  

    // Flush on unmount — covers step change (parent re-keys us), panel
    // close, page navigation. Without this, clicking another node within
    // 600ms of typing would silently discard the edit.
    useEffect(() => () => { flushNow(); }, []);  

    // `@container/ndvset`: the footer fits itself to the settings column, not the window.
    // SlotListAsContext: how THIS step's run writes a list into its inputs'
    // text (JSON for tool, AI, code, table and HTTP steps), so every value
    // editor below previews what the step will actually receive.
    return (
        <SlotListAsContext.Provider value={listAsForStepType(step?.type)}>
        <div className="@container/ndvset flex-1 min-h-0 flex flex-col">
            {(stepIssues.errors.length > 0 || stepIssues.warnings.length > 0) && (
                <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--border-default)]">
                    {/* Say what KIND of problem this is before listing it — a
                        blocking error and a nice-to-know used to look the same
                        apart from their hue. */}
                    {stepIssues.errors.length > 0 && (
                        <div className="text-[11px] font-semibold text-red-600 dark:text-red-400 mb-0.5">
                            {t('automations.builder.fix_before_run', 'Fix this before the automation can run:')}
                        </div>
                    )}
                    {stepIssues.errors.map((e, i) => <ValidationLine key={`e-${i}`} record={e} />)}
                    {stepIssues.warnings.length > 0 && (
                        <div className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 mb-0.5 mt-1 first:mt-0">
                            {t('automations.builder.worth_checking', 'Worth checking:')}
                        </div>
                    )}
                    {stepIssues.warnings.map((w, i) => <ValidationLine key={`w-${i}`} record={w} />)}
                </div>
            )}

            {/* space-y-4 between sections against space-y-2.5 within one (the
                rail in CollapsibleSection) — grouping by proximity, which the
                surface tokens are too close together to carry on their own.
                On a wide screen the form keeps a readable measure, centred,
                instead of stretching every field across it. */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-3 [&>*]:max-w-[1040px] [&>*]:mx-auto">
                {/* The step's name and symbol on ONE line, without a heading of
                    its own: the panel header already names the step, and the
                    field says what it is (its placeholder and accessible name). */}
                <div className="flex items-center gap-2" title="A name and an optional symbol for this step, shown on its node.">
                    <IconPicker
                        value={draft.icon || ''}
                        onChange={(name) => set('icon', name)}
                        title="Choose a symbol for this step"
                    />
                    <input
                        type="text"
                        value={draft.label || ''}
                        onChange={(e) => set('label', e.target.value)}
                        placeholder={defaultLabelPlaceholder(step)}
                        aria-label="Step name"
                        className={inputClass() + ' flex-1'}
                    />
                </div>

                {step.type === 'trigger' && (
                    <TriggerFields draft={draft} set={set} setNested={setNested} errorSections={errorSections} catalog={catalog} automation={automation} stepId={step.id} isSecondaryTrigger={isSecondaryTrigger} onTestSubmit={onTestSubmit} onRenameField={onRenameField} />
                )}

                {step.type === 'ai_step' && (
                    <AiStepFields
                        draft={draft} set={set} modelTiers={modelTiers}
                        catalog={catalog} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections} runStep={runStep}
                    />
                )}

                {step.type === 'integration_action' && (
                    <IntegrationActionFields
                        step={step} draft={draft} set={set}
                        catalog={catalog} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections} runStep={runStep}
                    />
                )}

                {/* If / Switch / Filter (route) / Filter (collection) are one
                    node with one editor — see flow/routeModel.js. */}
                {isRouteStep(step) && (
                    <RouteFields
                        step={step} draft={draft} set={set} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections} wiredCaseNames={wiredCaseNames}
                        onInsertUpstreamStep={onInsertUpstreamStep}
                        routeFollow={routeFollow} wholeRun={wholeRun}
                        topics={topicsCapability(catalog)}
                    />
                )}

                {step.type === 'loop' && (
                    <LoopFields
                        draft={draft} set={set}
                        groups={groups} onFocusField={onFocusField}
                        previewSample={previewSample} catalog={catalog}
                        modelTiers={modelTiers} rootDefinition={rootDefinition}
                        blocksCatalog={blocksCatalog}
                        errorSections={errorSections}
                        onExpandOnCanvas={onExpandOnCanvas ? () => onExpandOnCanvas(step.id) : null}
                    />
                )}

                {step.type === 'code' && (
                    <CodeFields step={step} draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}

                {step.type === 'notification' && (
                    <NotificationFields
                        draft={draft} set={set} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections}
                    />
                )}

                {step.type === 'http_request' && (
                    <HttpRequestFields
                        draft={draft} set={set} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections} catalog={catalog}
                    />
                )}

                {step.type === 'generate_document' && (
                    <GenerateDocumentFields
                        draft={draft} set={set}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections}
                    />
                )}

                {step.type === 'fill_document' && (
                    <FillDocumentFields
                        draft={draft} set={set}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections}
                    />
                )}

                {step.type === 'slide' && (
                    <SlideFields
                        draft={draft} set={set} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections}
                    />
                )}

                {step.type === 'presentation' && (
                    <PresentationFields
                        draft={draft} set={set}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections}
                    />
                )}

                {step.type === 'data_extraction' && (
                    <DataExtractionFields
                        draft={draft} set={set} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections}
                    />
                )}

                {step.type === 'call_layer' && (
                    <CallLayerFields step={step} draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} rootDefinition={rootDefinition} errorSections={errorSections} />
                )}
                {step.type === 'call_block' && (
                    <CallStepFields step={step} draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} blocksCatalog={blocksCatalog} errorSections={errorSections} />
                )}
                {step.type === 'layer_output' && (
                    <LayerOutputFields draft={draft} set={set} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}

                {step.type === 'set' && (
                    <SetFields step={step} draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} runStep={runStep} />
                )}
                {step.type === 'parse_json' && (
                    <ParseJsonFields step={step} draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {step.type === 'datetime' && (
                    <DateTimeFields draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {step.type === 'wait' && (
                    <WaitFields draft={draft} set={set} errorSections={errorSections} />
                )}
                {step.type === 'approval' && (
                    <ApprovalFields draft={draft} set={set} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {isPrivacyStep(step) && (
                    <PrivacyShieldFields
                        step={step} draft={draft} set={set} groups={groups}
                        onFocusField={onFocusField} previewSample={previewSample}
                        errorSections={errorSections} stepEdges={stepEdges}
                    />
                )}
                {step.type === 'stop_error' && (
                    <StopErrorFields draft={draft} set={set} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {step.type === 'return_to_app' && (
                    <ReturnToAppFields draft={draft} set={set} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {step.type === 'form_page' && (
                    <FormPageFields draft={draft} set={set} stepId={step.id} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} onRenameField={onRenameField} />
                )}
                {step.type === 'limit' && (
                    <LimitFields draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {step.type === 'dedupe' && (
                    <DedupeFields draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {step.type === 'flatten' && (
                    <FlattenFields draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} sampleFromRun={sampleFromRunOf(groups, draft.arrayRef)} errorSections={errorSections} />
                )}
                {step.type === 'datatable' && (
                    <DatatableFields
                        draft={draft} set={set} groups={groups} onFocusField={onFocusField}
                        previewSample={previewSample} errorSections={errorSections} catalog={catalog}
                    />
                )}
                {step.type === 'knowledge_write' && (
                    <KnowledgeWriteFields
                        draft={draft} set={set} groups={groups} onFocusField={onFocusField}
                        previewSample={previewSample} errorSections={errorSections} catalog={catalog}
                    />
                )}
                {step.type === 'aggregate' && (
                    <AggregateFields draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}
                {step.type === 'summarize' && (
                    <SummarizeFields draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />
                )}

                {/* Not in Simple mode: that view's whole point is that it
                    doesn't talk about JSON. BFSF-481: the sentence used to be
                    dead text naming a view that did not exist; now it IS the
                    control. */}
                {formMode !== 'simple' && (
                    <JsonConfigSection draft={draft} onApply={setDraft} />
                )}
            </div>

            {saveError && (
                <div className="flex-shrink-0 px-3 py-2 text-xs text-red-600 dark:text-red-400 border-t border-[var(--border-default)] bg-red-500/5">
                    {saveError}
                </div>
            )}
            <div className="flex-shrink-0 flex items-center gap-3 px-3 py-2 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11px] whitespace-nowrap">
                {footerLeft}
                {/* "1 field still empty" (artboard 2b) — the INVERSE of
                    boundPaths over the slots this step declares, counted on the
                    live DRAFT so it updates while you fill things in rather
                    than after a save. Silent at zero: a form with nothing wrong
                    should say nothing. */}
                {emptySlots.unknown ? (
                    /* "I cannot check" — never silence, and never a number.
                       The tool's own parameter list is missing, so the count
                       below would be of the slots that happen to be written
                       down, which for an untouched step is none at all. Its
                       own wording and its own colour, so it cannot be read as
                       "nothing wrong" (which is what silence means here). */
                    <span
                        className="shrink-0 px-[7px] rounded-full border font-semibold leading-[18px]"
                        style={{ borderColor: 'var(--warning)', color: 'var(--warning-ink)' }}
                        title={t('automations.builder.fields_unknown_hint', 'This step\u2019s tool details could not be loaded, so its required fields cannot be checked. Reload the page to try again.')}
                        data-testid="settings-empty-slots-unknown"
                    >
                        {t('automations.builder.fields_unknown', 'Cannot check the fields')}
                    </span>
                ) : emptySlots.empty > 0 && (
                    <span
                        className="shrink-0 px-[7px] rounded-full border font-semibold leading-[18px]"
                        style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
                        title={emptySlots.keys.join(', ')}
                        data-testid="settings-empty-slots"
                    >
                        {emptySlots.empty === 1
                            ? t('automations.builder.one_field_empty', '1 field still empty')
                            : t('automations.builder.n_fields_empty', '{n} fields still empty', { n: emptySlots.empty })}
                    </span>
                )}
                <div className="ml-auto shrink-0 flex items-center gap-2">
                    {/* Autosave is the real save path; say so, or the Save
                        button implies edits are lost without it. It stays as
                        the immediate-save escape (and the tests' landmark —
                        its text is queried by name across 10 suites). */}
                    {/* Quiet, so it is the first to go where the column is narrow:
                        the header's save chip says the same. */}
                    {!compactFooter && (
                        <span className={`${hintTextClass()} text-[var(--text-tertiary)] @max-[720px]/ndvset:hidden`}>
                            {t('automations.builder.autosave_note', 'Changes save automatically.')}
                        </span>
                    )}
                    <button
                        onClick={reset}
                        disabled={!dirty || saving}
                        className="flex items-center gap-1.5 px-3 py-1 text-xs rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 transition"
                    >
                        <RotateCcw size={12} /> <span className="@max-[480px]/ndvset:sr-only">{t('automations.builder.undo_changes', 'Undo changes')}</span>
                    </button>
                    <button
                        onClick={onSave}
                        disabled={!dirty || saving}
                        className={controlSurfaceClass('flex items-center gap-1.5 px-3 py-1 text-xs hover:bg-[var(--bg-tertiary)] disabled:opacity-40')}
                    >
                        <Save size={12} /> {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
        </SlotListAsContext.Provider>
    );
}

