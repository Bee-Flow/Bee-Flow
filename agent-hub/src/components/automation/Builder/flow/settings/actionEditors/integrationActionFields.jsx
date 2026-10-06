// The integration_action editor: which operation the node runs, the inputs
// that operation takes, and the advanced section that fans it out or lets it
// ask the app only once.
import React, { useMemo, useState } from 'react';
import ActionCard from './ActionCard';
import { buildParamSuggestions } from './paramSuggestions';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { essentialFromSchema, paramsFromSchema } from '../../../mapping/aiAutoMap';
import { autoMapInputs } from '../../../mapping/autoMapInputs';
import ToolInputForm from '../../../mapping/ToolInputForm';
import AccordionSection from '../../AccordionSection';
import { humanizeToolName } from '../../displayHelpers';
import FieldHint from '../../FieldHint';
import { ForEachSection, RetrySection, retryIsSet } from '../collectionEditors';
import { runStepProblem } from '../runProblem';
import { isTablesRowTool, withoutValuesInput } from '../tablesRowValues';
import TablesRowValuesEditor from '../TablesRowValuesEditor';
import { AskOnceRow, askOnceAvailability } from './askOnceRow';
import { deepenedForEach, findNestedColumn, nestedListPick, rebindToNewItem } from '../../../mapping/deepenForEach';
import { expectedShapeFor } from '../../../mapping/listShape';
import { isEmptyBinding } from '../../../mapping/partitionInputs';
import useAiAutoMap from '../../../mapping/useAiAutoMap';

/**
 * Where the last run's error points (round 4, artboard 4a; see ../runProblem).
 * An input ring wants the bare input name; 'connection' and 'tool' ring the
 * action card, which is where app and account live.
 */
function runProblem(runStep, t) {
    const problem = runStepProblem(runStep, t);
    if (!problem) return { problemKey: null, problemText: null, cardProblem: null };
    const { settingKey, text } = problem;
    const problemKey = settingKey.startsWith('inputs.') ? settingKey.slice('inputs.'.length) : null;
    return {
        problemKey,
        problemText: problemKey ? text : null,
        cardProblem: settingKey === 'connection' || settingKey === 'tool' ? text : null,
    };
}

/** The outer items a per-item step keeps (`forEach.parents`), by name. */
const outerItemVars = (fe) => (Array.isArray(fe?.parents) ? fe.parents.map(p => p?.itemVar) : []);

// `mappingApi` ({ suggestMappings }) replaces the API client in tests.
function IntegrationActionFields({ step, draft, set, catalog, groups = [], onFocusField, previewSample, errorSections = new Set(), runStep = null, mappingApi = null }) {
    const { t } = useTranslation();
    // Track the live tool from the draft so switching operation updates the
    // inputs form immediately (before the patch round-trips and step.tool
    // catches up).
    const currentTool = draft.tool || step.tool;
    const { action, siblings, appLabel } = useMemo(
        () => findActionAndSiblings(catalog, currentTool, draft.appId || step.appId),
        [catalog, currentTool, draft.appId, step.appId],
    );
    const inputSchema = action?.inputSchema || null;
    // What the form shows: a Tables row's `values` map has its own editor and
    // is never something to fill with one field.
    const formSchema = isTablesRowTool(currentTool) ? withoutValuesInput(inputSchema) : inputSchema;
    const askAi = useAiAutoMap({ inputs: draft.inputs || {}, api: mappingApi });
    // Inputs the wand filled get the same small "auto" pill a connect-time
    // auto-map leaves (step.autoMapped) until the author edits them. Local:
    // the form re-keys per step, and a reload shows plain values again.
    const [wandMapped, setWandMapped] = useState([]);
    // The subset the AI filled: those carry "auto · AI" so the author checks them.
    const [aiMapped, setAiMapped] = useState([]);
    const markMapped = (keys) => { if (keys.length) setWandMapped(prev => [...new Set([...prev, ...keys])]); };
    const autoMappedKeys = useMemo(() => [...new Set([...(step.autoMapped || []), ...wandMapped])], [step.autoMapped, wandMapped]);
    const onAutoMap = () => {
        const before = draft.inputs || {};
        const patch = autoMapInputs(inputSchema, before, groups || []);
        let next = { ...before, ...patch };
        let deepened = false;
        // A step that runs per item: a required input still empty may live in a
        // list inside that item (a mail's attachments). Same move as dragging
        // that column: the step runs per attachment, the other fields follow.
        // Only for an input that takes ONE value, as a pick does (and as the
        // phone's nestedColumnPatch does): a list parameter is never a reason
        // to change how often the step runs.
        const fe = draft.forEach;
        if (fe?.overRef) {
            const itemVar = fe.itemVar || 'item';
            const item = (groups || []).find(g => g.basePath === `loop.${itemVar}`)?.sample;
            const required = new Set(inputSchema?.required || []);
            const empty = Object.keys(inputSchema?.properties || {})
                .filter(k => isEmptyBinding(next[k]) && expectedShapeFor(inputSchema.properties[k]) === 'scalar')
                .sort((a, b) => (required.has(b) ? 1 : 0) - (required.has(a) ? 1 : 0));
            const hit = findNestedColumn(empty, item, itemVar);
            // The new item is never named like an outer item the step keeps.
            const plan = hit ? nestedListPick(hit.path, itemVar, outerItemVars(fe)) : null;
            if (plan) {
                next[hit.key] = { kind: 'ref', path: `loop.${plan.itemVar}${plan.fieldTail}` };
                next = rebindToNewItem(next, plan, hit.element, fe).inputs;
                set('forEach', deepenedForEach(fe, plan, previewSample));
                deepened = true;
            }
        }
        const filled = Object.keys(next).filter(k => isEmptyBinding(before[k]) && !isEmptyBinding(next[k]));
        if (filled.length) set('inputs', next);
        markMapped(filled);
        // Then the AI, for the required inputs still empty — on this click
        // only, never on connect. Its bindings land only in inputs that are
        // still empty when it answers, and only for the same operation. Not
        // after the step just moved to a deeper list: the upstream fields it
        // would be shown are the ones the step no longer runs over.
        const tool = currentTool;
        askAi({
            params: deepened ? [] : paramsFromSchema(formSchema),
            essential: essentialFromSchema(formSchema, next),
            inputs: next,
            groups: groups || [],
            step: { label: draft.label || step.label || '', tool: tool || '' },
            deterministicCount: filled.length,
            write: (fill) => set('inputs', (cur, d) => ((d?.tool || step.tool) === tool ? fill(cur || {}) : cur)),
        }).then(({ aiKeys }) => {
            markMapped(aiKeys);
            if (aiKeys.length) setAiMapped(prev => [...new Set([...prev, ...aiKeys])]);
        });
    };
    // "Run once per item" from a field lands here. Advanced stays closed: the
    // field itself says the step now runs per item, with Undo, and Advanced
    // shows "set" on its band.
    const requestForEach = React.useCallback((fe) => {
        set('forEach', fe ? { itemVar: 'item', maxIterations: 100, ...(draft.forEach || {}), ...fe } : null);
    }, [draft.forEach, set]);
    // While the step runs per item: a value from a list INSIDE that item
    // (Attachments ▸ Attachment id while it runs per email) moves the run to
    // that list, and the fields that read the old item move to the new one.
    // Both writes are updaters, so they land after the field's own change.
    // `forEach` lets a column picked by its full path (`orders[*].line_items[*].sku`
    // while the step runs per order) move the step down too; the preview data
    // settles how the levels join (deepenForEach.deepenedForEach).
    const deepenForEach = React.useMemo(() => ({
        itemVar: draft.forEach?.itemVar || 'item',
        forEach: draft.forEach || null,
        apply: (plan, newItem) => {
            const before = { forEach: draft.forEach, inputs: draft.inputs };
            set('forEach', (fe) => deepenedForEach(fe, plan, previewSample));
            set('inputs', (cur) => rebindToNewItem(cur, plan, newItem, draft.forEach).inputs);
            // What cannot move is known from the fields as they are now: the
            // field just picked already reads the new item.
            const { orphans } = rebindToNewItem(draft.inputs, plan, newItem, draft.forEach);
            const undo = () => { set('forEach', before.forEach); set('inputs', before.inputs); };
            return { undo, runs: null, orphans };
        },
    }), [draft.forEach, draft.inputs, set, previewSample]);
    // Same app = one node with a switchable operation (n8n-style). Keep the
    // inputs that also exist in the new operation; drop the rest.
    const onChangeOperation = (newTool) => {
        if (!newTool || newTool === currentTool) return;
        const next = siblings.find(a => a.name === newTool);
        const allowed = next?.inputSchema?.properties ? new Set(Object.keys(next.inputSchema.properties)) : null;
        const prevInputs = draft.inputs || {};
        const keptInputs = allowed
            ? Object.fromEntries(Object.entries(prevInputs).filter(([k]) => allowed.has(k)))
            : prevInputs;
        set('tool', newTool);
        set('label', next?.label || humanizeToolName(newTool));
        set('inputs', keptInputs);
        if (next?.sideEffect != null) set('sideEffect', next.sideEffect);
    };
    // Round 4 (artboard 4b): a suggestion for each empty required setting.
    const suggestions = useMemo(
        () => buildParamSuggestions(inputSchema, draft.inputs || {}, groups || [], autoMapInputs, t),
        [inputSchema, draft.inputs, groups, t],
    );
    // Round 4 (artboard 4a): the setting the last run's error names gets the
    // red ring. Only when the run failed on THIS step with a classified error.
    const { problemKey, problemText, cardProblem } = runProblem(runStep, t);
    // Both the seed-open and the "already configured, keep it in Simple mode"
    // signal ask the same question, so ask it once.
    const advancedIsSet = !!draft.forEach || !!draft.askOnce || retryIsSet(draft);
    return (
        <>
            {/* The action as a card, not an Operation dropdown (round 4). */}
            <ActionCard
                tool={currentTool || null}
                appLabel={appLabel}
                action={action}
                siblings={siblings}
                onSwitch={onChangeOperation}
                problem={cardProblem}
            />
            {/* meta is titled "About Inputs", not "Inputs": Info derives its
                aria-label from the title, and the band's own toggle button is
                already named after the section. */}
            <AccordionSection
                stepType="integration_action" sectionKey="inputs" title="Inputs"
                defaultOpen forceOpen={errorSections.has('inputs')}
                meta={<FieldHint title="About Inputs">{inputSchema ? 'Field values passed to the tool. Pick a variable from the right panel to bind upstream output.' : 'No schema found for this tool — using generic key/value rows.'}</FieldHint>}
            >
                <ToolInputForm
                    inputs={draft.inputs || {}}
                    onChange={(next) => set('inputs', next)}
                    // A Tables row's `values` is a map of column title → binding.
                    // The generic form can only offer it as raw JSON, which
                    // nobody can fill in; the column-aware editor below takes
                    // it over, so hide it here or the map is offered twice.
                    inputSchema={formSchema}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    autoMappedKeys={autoMappedKeys}
                    aiMappedKeys={aiMapped}
                    onAutoMap={onAutoMap}
                    // Not while the step already runs per item: a second list would orphan
                    // every field that reads the current one.
                    onRequestForEach={draft.forEach?.overRef ? null : requestForEach}
                    deepenForEach={draft.forEach?.overRef ? deepenForEach : null}
                    // Only let the user add ad-hoc fields when the tool can
                    // actually accept them: a fixed schema (gmail_search etc.)
                    // doesn't, so hide "Add custom field"; a tool with no
                    // schema needs the generic key/value rows.
                    allowExtraFields={inputSchema ? inputSchema.additionalProperties === true : true}
                    suggestions={suggestions}
                    tool={currentTool || null}
                    problemKey={problemKey}
                    problemText={problemText}
                />
                {isTablesRowTool(currentTool) && (
                    <TablesRowValuesEditor
                        step={step}
                        tool={currentTool}
                        tableId={(draft.inputs || {}).tableId}
                        value={(draft.inputs || {}).values}
                        onChange={(v) => set('inputs', { ...(draft.inputs || {}), values: v })}
                        groups={groups}
                        catalog={catalog}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                )}
            </AccordionSection>
            <AccordionSection stepType="integration_action" sectionKey="advanced" title="Advanced" defaultOpen={advancedIsSet} forceOpen={errorSections.has('advanced')} hasContent={advancedIsSet}>
                <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                <RetrySection draft={draft} set={set} />
                <AskOnceRow draft={draft} set={set} {...askOnceAvailability(action, appLabel)} />
            </AccordionSection>
        </>
    );
}

/**
 * Locate the catalog action for `toolName` and all sibling actions of the
 * same app (used by the operation switcher). Falls back to `appId` when the
 * tool itself isn't in the catalog (e.g. the app isn't connected) so the
 * operation list still renders.
 */
export function findActionAndSiblings(catalog, toolName, appId) {
    if (!catalog?.apps) return { action: null, siblings: [], appLabel: null };
    for (const app of catalog.apps) {
        const action = (app.actions || []).find(a => a.name === toolName);
        if (action) return { action, siblings: app.actions || [], appLabel: app.label || null };
    }
    if (appId) {
        const app = catalog.apps.find(a => a.id === appId
            || (a.actions || []).some(x => (x.integrationId || a.id) === appId));
        if (app) return { action: null, siblings: app.actions || [], appLabel: app.label || null };
    }
    return { action: null, siblings: [], appLabel: null };
}

export { IntegrationActionFields };
