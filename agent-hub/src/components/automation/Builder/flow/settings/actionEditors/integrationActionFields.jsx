// The integration_action editor: which operation the node runs, the inputs
// that operation takes, and the advanced section that fans it out or lets it
// ask the app only once.
import React, { useMemo, useState } from 'react';
import ActionCard from './ActionCard';
import { buildParamSuggestions } from './paramSuggestions';
import { useTranslation } from '../../../../../../hooks/useTranslation';
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

function IntegrationActionFields({ step, draft, set, catalog, groups = [], onFocusField, previewSample, errorSections = new Set(), runStep = null }) {
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
    const onAutoMap = () => {
        const patch = autoMapInputs(inputSchema, draft.inputs || {}, groups || []);
        if (Object.keys(patch).length) set('inputs', { ...(draft.inputs || {}), ...patch });
    };
    // A list-pick chooser choice of "run this step once for each row" lands
    // here: write the forEach and force the Advanced section (which holds its
    // editor) open once, so the change is visible where it can be undone.
    const [foreachJustSet, setForeachJustSet] = useState(false);
    const requestForEach = React.useCallback((fe) => {
        set('forEach', fe ? { itemVar: 'item', maxIterations: 100, ...(draft.forEach || {}), ...fe } : null);
        setForeachJustSet(!!fe);
    }, [draft.forEach, set]);
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
                    inputSchema={isTablesRowTool(currentTool) ? withoutValuesInput(inputSchema) : inputSchema}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    autoMappedKeys={step.autoMapped || []}
                    onAutoMap={onAutoMap}
                    onRequestForEach={requestForEach}
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
            <AccordionSection stepType="integration_action" sectionKey="advanced" title="Advanced" defaultOpen={advancedIsSet} forceOpen={errorSections.has('advanced') || foreachJustSet} hasContent={advancedIsSet}>
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
