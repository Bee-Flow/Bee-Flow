// The "Edit data" (set) editor with its JSON-extract footer, extracted
// verbatim from SettingsForm.jsx.
import { useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { walkPath } from '../../../../../utils/bindingHelpers';
import { skipGroupOfStep } from '../../../../shared/statusTokens';
import JsonTreePicker from '../../mapping/JsonTreePicker';
import ValueSlot from '../../valueSlot/ValueSlot';
import { sampleToFields } from '../../mapping/upstream';
import { VariablePickerProvider, useVariablePickerContext } from '../../mapping/VariablePickerContext';
import AccordionSection from '../AccordionSection';
import { humanizeFieldKey } from '../displayHelpers';
import { ForEachSection, FieldsSection, SourceSummaryRow, useElementSample } from './collectionEditors';
import { useFormMode } from './formDensity';
import { FormRow, inputClass } from './formPrimitives';
import { parseSampleSource, suggestFieldName } from './ParseJsonFields';
import SetOperationsEditor from './SetOperationsEditor';

const DETECTED_SOURCE_HINT = 'Detected from the step above. The fields are computed for each row of this list.';

/**
 * The "Edit data" (set) editor. Two modes, derived — never stored — from the
 * presence of `arrayRef` (the same convention the Condition node uses):
 *
 *   single — today's form, untouched: a fields map building one object.
 *   list   — the step works through an upstream table/list: a one-line
 *            source summary, per-row Fields with the row in scope as
 *            "Current row", and whole-table "Table tools" (number rows,
 *            shared IDs, rename/keep/remove, sort).
 *
 * Mode detection happens on wire (mapping/autoMapInputs.js) and stays
 * overridable under Advanced. `forEach` remains for legacy single-mode steps
 * only — in list mode it's superseded and cleared on save (formState.js).
 */
function SetFields({ step, draft, set, groups = [], onFocusField, previewSample, errorSections = new Set(), runStep = null }) {
    const { t } = useTranslation();
    const pickerCtx = useVariablePickerContext();
    // Simple mode = "only what you need". Which list this step walks through
    // is detected on wire and is right the overwhelming majority of the time,
    // so it belongs with the other overrides — UNLESS it's still unset, in
    // which case the step can't run and hiding the control would be a dead
    // end. Follows the user's MODE, not the window size.
    const compact = useFormMode() === 'simple';
    const listMode = typeof draft.arrayRef === 'string';
    const elementSample = useElementSample(listMode ? draft.arrayRef : '', previewSample);
    // A source that is SET but no longer found is as much a dead end as an
    // unset one, and in Simple mode Advanced is hidden, so the one control
    // that fixes it was out of reach (BFSF-363). Such a source is promoted
    // above the fields exactly like an unset one.
    const unresolved = listMode && sourceListUnresolved(draft.arrayRef, runStep, previewSample, groups);
    const sourceOnTop = listMode && (!draft.arrayRef || unresolved);

    // Scope the per-row field editors to the CURRENT ROW — the exact
    // RouteFields recipe: an `item` group so the {} picker offers "Current
    // row", plus a preview root so `item.*` refs/exprs resolve to examples.
    const itemScope = useMemo(() => {
        if (!listMode || elementSample == null) return null;
        const isObj = typeof elementSample === 'object' && !Array.isArray(elementSample);
        const itemGroup = {
            id: '__set_item',
            label: 'Current row',
            kind: 'loop',
            basePath: 'item',
            sample: elementSample,
            fields: isObj ? sampleToFields(elementSample, 'item') : [],
        };
        return {
            groups: [itemGroup, ...(pickerCtx.groups || [])],
            previewSample: { ...(previewSample || {}), item: elementSample, _index: 0 },
        };
    }, [listMode, elementSample, pickerCtx.groups, previewSample]);
    const effectivePreview = itemScope ? itemScope.previewSample : previewSample;

    // Columns BEFORE any table tool runs: the source row's own keys (a scalar
    // list reads as its `value` wrap — runtime row rule 1) plus the computed
    // fields above. Each op card then folds the EARLIER ops on top.
    const baseColumns = useMemo(() => {
        const cols = [];
        if (elementSample != null && typeof elementSample === 'object' && !Array.isArray(elementSample)) cols.push(...Object.keys(elementSample));
        else if (elementSample != null) cols.push('value');
        cols.push(...Object.keys(draft.fields || {}));
        return [...new Set(cols)];
    }, [elementSample, draft.fields]);
    const columnSamples = useMemo(() => {
        if (elementSample != null && typeof elementSample === 'object' && !Array.isArray(elementSample)) return elementSample;
        return elementSample != null ? { value: elementSample } : {};
    }, [elementSample]);

    const scoped = (node) => (itemScope ? (
        <VariablePickerProvider
            groups={itemScope.groups}
            previewSample={itemScope.previewSample}
            stepLabelById={pickerCtx.stepLabelById}
        >
            {node}
        </VariablePickerProvider>
    ) : node);

    const ops = Array.isArray(draft.operations) ? draft.operations : [];

    return (
        <>
            {sourceOnTop && (
                <SourceSummaryRow
                    hint={unresolved
                        ? DETECTED_SOURCE_HINT
                        : 'This step has no list to work through yet — pick the step whose results it should edit.'}
                    warning={unresolved
                        ? t('routines.ndv.set_source_unresolved', 'This list was not found in the latest data, so this step had nothing to work through. Pick the list again, or re-run the step that produces it.')
                        : null}
                    source={draft.arrayRef}
                    maxItems={draft.maxItems}
                    onPatch={(p) => ('source' in p ? set('arrayRef', p.source) : set('maxItems', p.maxItems))}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            )}
            {scoped(
                <FieldsSection
                    draft={draft}
                    set={set}
                    stepType="set"
                    title={listMode ? 'Fields added to each row' : 'Fields'}
                    hint={listMode
                        ? 'Every row keeps its own data. The fields below are worked out for each row — reuse a name to overwrite that column.'
                        : 'One record, built field by field.'}
                    onFocusField={onFocusField}
                    previewSample={effectivePreview}
                    errorSections={errorSections}
                    inputProps={{
                        nameLabel: listMode ? 'Column name' : 'Field name',
                        valueLabel: 'What goes in it',
                        namePlaceholder: listMode ? 'e.g. status' : 'e.g. customer',
                        valuePlaceholder: 'Type a value…',
                        allowRawValues: !compact,
                    }}
                    footer={(
                        <JsonExtractSection
                            draft={draft}
                            set={set}
                            listMode={listMode}
                            elementSample={elementSample}
                            previewSample={effectivePreview}
                        />
                    )}
                />,
            )}
            {listMode && (
                <AccordionSection stepType="set" sectionKey="table" title="Table tools" defaultOpen forceOpen={errorSections.has('table')}>
                    <p className="text-[11px] text-[var(--text-tertiary)] mb-2">
                        Applied to the whole table, top to bottom, after the fields above.
                    </p>
                    <SetOperationsEditor
                        ops={ops}
                        onChange={(next) => set('operations', next)}
                        baseColumns={baseColumns}
                        columnSamples={columnSamples}
                        onFocusField={onFocusField}
                    />
                </AccordionSection>
            )}
            <AccordionSection stepType="set" sectionKey="advanced" title="Advanced" defaultOpen={!listMode && !!draft.forEach} forceOpen={errorSections.has('advanced')} hasContent={!listMode && !!draft.forEach}>
                <FormRow label="Works on" hint="Detected from the step above — override it here if the guess is wrong.">
                    <select
                        value={listMode ? 'items' : 'single'}
                        onChange={(e) => set('arrayRef', e.target.value === 'items' ? (draft.arrayRef ?? '') : null)}
                        className={inputClass()}
                    >
                        <option value="items">Each row of a list</option>
                        <option value="single">The whole run</option>
                    </select>
                    {listMode && ops.length > 0 && (
                        <div className="mt-1 text-[10px] text-[var(--text-tertiary)]">
                            Switching to “The whole run” also removes the table tools.
                        </div>
                    )}
                </FormRow>
                {/* Which list this step walks lives HERE, not above the fields:
                    it is detected on wire, right nearly always, and reading
                    `steps.act_4d…output.results` taught the user nothing. The
                    summary names the step and the field; `change` reveals the
                    same path editor the other collection steps use. */}
                {listMode && !sourceOnTop && (
                    <SourceSummaryRow
                        hint={DETECTED_SOURCE_HINT}
                        source={draft.arrayRef}
                        maxItems={draft.maxItems}
                        onPatch={(p) => ('source' in p ? set('arrayRef', p.source) : set('maxItems', p.maxItems))}
                        groups={groups}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                )}
                {!listMode && <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />}
                {listMode && step?.forEach && (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400">
                        List mode replaces “Run once per item” — saving removes the old per-item setting.
                    </div>
                )}
            </AccordionSection>
        </>
    );
}

/**
 * Is this step's source list set but not found (BFSF-363)? Either signal:
 *
 *  - The step's own last run skipped because the list did not resolve. This
 *    is the one that counts: the editor preview can show a list the run
 *    itself never saw. The runner's code for it (`arrayref_unresolved`) is
 *    not persisted yet, so the row's shape answers (skipGroupOfStep): for
 *    Edit data the only skip that writes its sentence to `output.skipped`
 *    is that one.
 *  - Otherwise the preview: the step (or trigger) the path starts from has
 *    REAL data (a run or a pin, `hasRealData` on its group), and there is no
 *    list at the path. The preview root alone is no evidence: buildSampleRoot
 *    fills every upstream step from the catalog's design sample (`{}` at
 *    least), and a design sample that lacks the path says nothing about a
 *    run. A step whose upstream never ran is not flagged; there is nothing to
 *    compare against yet.
 */
function sourceListUnresolved(arrayRef, runStep, previewSample, groups) {
    // The root regex below is linear: anchored, and its one repeat is a class
    // that excludes the '.' it must stop at, so a failed match backtracks once.
    const path = typeof arrayRef === 'string' ? arrayRef.trim() : ''; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    if (!path) return false;
    if (runStep?.status === 'skipped' && skipGroupOfStep(runStep) === 'no_work') return true;
    const root = /^(?:steps\.[^.[\]]+|trigger)\.output(?![A-Za-z0-9_$])/.exec(path);
    if (!root || !previewSample) return false;
    const ranUpstream = (groups || []).some(g => g?.hasRealData && g.basePath === root[0]);
    if (!ranUpstream) return false;
    return walkPath(root[0], previewSample) != null && !Array.isArray(walkPath(path, previewSample));
}

/**
 * "Some of this data is JSON text · Pick fields from it" — the Parse JSON
 * node's successor, folded into Edit data. Rendered only when an upstream
 * sample (or, in list mode, a field of the current row) is a string that
 * parses to a JSON object/array. A pick appends a computed field whose value
 * is a `parseJson(<source>, "<path>")` expression — deterministic, free at
 * run time, and visible/editable like any other field.
 */
function JsonExtractSection({ draft, set, listMode, elementSample, previewSample }) {
    const pickerCtx = useVariablePickerContext();
    const [open, setOpen] = useState(false);
    const [changing, setChanging] = useState(false);
    const [customSource, setCustomSource] = useState(null);

    const PREFERRED = /body|content|text|json|payload|raw/i;
    const jsonish = (v) => {
        if (typeof v !== 'string') return false;
        const parsed = parseSampleSource(v);
        return parsed !== undefined && parsed !== null && typeof parsed === 'object';
    };

    const candidates = useMemo(() => {
        const found = [];
        if (listMode) {
            if (elementSample && typeof elementSample === 'object' && !Array.isArray(elementSample)) {
                for (const [k, v] of Object.entries(elementSample)) {
                    if (jsonish(v)) found.push({ path: `item.${k}`, label: `each row · ${humanizeFieldKey(k)}`, preferred: PREFERRED.test(k) });
                }
            }
        } else {
            // Nearest upstream step first (groups are in execution order).
            const gs = pickerCtx.groups || [];
            for (let i = gs.length - 1; i >= 0; i--) {
                const g = gs[i];
                for (const f of (g.fields || [])) {
                    if (jsonish(f.sample)) found.push({ path: f.path, label: `${g.label} · ${humanizeFieldKey(f.key)}`, preferred: PREFERRED.test(f.key) });
                    for (const c of (f.children || [])) {
                        if (jsonish(c.sample)) found.push({ path: c.path, label: `${g.label} · ${humanizeFieldKey(c.key)}`, preferred: PREFERRED.test(c.key) });
                    }
                }
            }
        }
        return found.sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
    }, [listMode, elementSample, pickerCtx.groups]);

    const sourcePath = customSource ?? candidates[0]?.path ?? '';
    const sourceLabel = candidates.find(c => c.path === sourcePath)?.label || sourcePath;
    const parsed = useMemo(() => {
        if (!sourcePath || !previewSample) return undefined;
        return parseSampleSource(walkPath(sourcePath, previewSample));
    }, [sourcePath, previewSample]);

    if (!candidates.length && customSource == null) return null;

    const addField = (relPath) => {
        const fields = draft.fields || {};
        const name = suggestFieldName(relPath, Object.keys(fields));
        // The expr grammar has no backslash escapes — pick whichever quote
        // style the path doesn't contain (a path needing both is unpickable
        // upstream in JsonTreePicker for the same reason).
        const quoted = relPath.includes('"') ? `'${relPath}'` : `"${relPath}"`;
        set('fields', { ...fields, [name]: { kind: 'expr', value: `parseJson(${sourcePath}, ${quoted})` } });
    };

    if (!open) {
        return (
            <div className="mt-2 text-[11px] text-[var(--text-secondary)]">
                Some of this data is JSON text ·{' '}
                <button type="button" onClick={() => setOpen(true)} className="text-[var(--accent)] hover:underline">
                    Pick fields from it
                </button>
            </div>
        );
    }

    return (
        <div className="mt-2 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/40 p-2 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <span className="truncate">From <span className="text-[var(--text-primary)]">{sourceLabel}</span></span>
                <button type="button" onClick={() => setChanging(c => !c)} className="ml-auto shrink-0 text-[10px] text-[var(--accent)] hover:underline">
                    {changing ? 'done' : 'change'}
                </button>
                <button type="button" onClick={() => setOpen(false)} className="shrink-0 text-[10px] text-[var(--text-tertiary)] hover:underline">
                    hide
                </button>
            </div>
            {changing && (
                <ValueSlot
                    storage="path"
                    allowTyping={false}
                    value={sourcePath}
                    onChange={(v) => setCustomSource(v)}
                    previewSample={previewSample}
                />
            )}
            {parsed !== undefined ? (
                <>
                    <JsonTreePicker value={parsed} onPick={addField} />
                    <div className="text-[10px] text-[var(--text-tertiary)]">
                        Click a value to add it as a field. Extraction is exact and free — no AI involved.
                    </div>
                </>
            ) : (
                <div className="text-[11px] italic text-[var(--text-tertiary)]">
                    This doesn’t look like JSON text — pick another source.
                </div>
            )}
        </div>
    );
}

export { SetFields };
