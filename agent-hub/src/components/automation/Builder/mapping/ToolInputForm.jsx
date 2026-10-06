import { Plus, Sparkles, Workflow } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { partitionInputs, isEmptyBinding } from './partitionInputs';
import GenericRow from './toolInput/GenericRow';
import MoreOptions from './toolInput/MoreOptions';
import ToolParamField from './toolInput/ToolParamField';
import useVariablePicker from './useVariablePicker';
import VariablePicker from './VariablePicker';
import { useVariablePickerContext } from './VariablePickerContext';
import { canonicalRefPath, suggestKeyFromPath } from '../../../../utils/bindingHelpers';
import { useFormMode } from '../flow/settings/formDensity';
import { actionButtonClass, subLabelClass } from '../flow/settings/formStyles';

/**
 * Schema-driven inputs editor for a step's `inputs` map.
 *
 * Two modes:
 *   1. Schema-driven — when `inputSchema?.properties` is provided
 *      (sourced from the catalog's per-tool function definition).
 *      Essential fields (required / populated / common) show by default;
 *      the rest collapse behind a "Show N more options" disclosure.
 *   2. Generic key/value rows — when no schema is available (custom
 *      tools, AI step user-defined inputs). User adds rows manually.
 *
 * Both modes emit the same `inputs` object the runtime resolver
 * expects: `{ [key]: bindingObject }`.
 *
 * Auto-mapping: `autoMappedKeys` marks fields filled by the connect-time
 * auto-mapper so a small "auto" pill is shown; `onAutoMap` (when given)
 * renders a one-click wand button to (re)run mapping over empty fields.
 */
export default function ToolInputForm({
    inputs = {},
    onChange,
    inputSchema = null,
    onFocusField,
    previewSample = null,
    allowExtraFields = true,
    autoMappedKeys = [],
    onAutoMap = null,
    // When true, a row whose value is cleared is KEPT (with an empty literal)
    // instead of being deleted. Used by the Set / layer_output editors, where
    // the keys are the user's own named fields — emptying a value must not
    // remove the field. Tool-param editors leave this off so clearing a value
    // omits the param.
    keepEmptyFields = false,
    // ValueBuilder is the DEFAULT renderer for every step-bound value slot
    // here — schema-declared parameters and the user's own named rows alike
    // (artboard 2a/2b: chips with the step's NAME and a "use it as" control,
    // not `{{steps.act_4d4307a.output.total}}` typed by hand). It keeps the
    // raw editor one click away ("Formula"), and hands anything it cannot
    // represent faithfully straight to BindingField, so nothing is ever
    // rewritten behind the author's back.
    //
    // Pass `visualValues={false}` to force the raw editor — the escape for a
    // surface whose values are not step bindings at all.
    visualValues = true,
    nameLabel = null,
    valueLabel = null,
    namePlaceholder = 'field name',
    valuePlaceholder = 'value',
    // Offer the "write it as a formula" escape up front (full density only).
    allowRawValues = true,
    // (forEach|null) => void — lets a list pick offer "run once per row".
    // Threaded per parameter with the schema-derived expectShape; custom rows
    // have no schema, so expectedShapeFor(undefined) === 'unknown' and the
    // chooser never fires there.
    onRequestForEach = null,
    // A value from a list inside the current item moves the step's forEach
    // to that list (deepenForEach.ts); only while the step runs per item.
    deepenForEach = null,
    // Round 4 (artboards 4a/4b), all optional and schema mode only:
    //   suggestions  { [key]: { binding, label, source } } for EMPTY required
    //                settings: a matching upstream field, else a safe default
    //   tool         the action's tool name, for the "Frequently used" chips
    //   problemKey / problemText  the setting the last run's error named
    //                (errorInfo.settingKey) and what went wrong with it
    suggestions = null,
    tool = null,
    problemKey = null,
    problemText = null,
    // Keys the Auto-map wand's AI fallback filled (useAiAutoMap's aiKeys):
    // their pill reads "auto · AI" instead of "auto".
    aiMappedKeys = [],
}) {
    const properties = inputSchema?.properties || null;
    const required = useMemo(() => new Set(inputSchema?.required || []), [inputSchema]);

    // The advanced-fields disclosure follows the form MODE: switching to All
    // options opens it (on the transition, not at mount), so "show me
    // everything" means everything — not "everything except the fields behind
    // this second click". The user's own toggle still works both ways.
    const formMode = useFormMode();
    const [advFieldsOpen, setAdvFieldsOpen] = useState(false);
    const prevModeRef = useRef(formMode);
    useEffect(() => {
        if (prevModeRef.current === 'simple' && formMode === 'advanced') setAdvFieldsOpen(true);
        prevModeRef.current = formMode;
    }, [formMode]);

    // Locally suppress the "auto" pill once the user edits that field. Resets
    // when the step changes (SettingsForm re-keys this subtree by step.id).
    const [consumed, setConsumed] = useState(() => new Set());
    const isAuto = (key) => {
        if (consumed.has(key)) return false;
        if (aiMappedKeys.includes(key)) return 'ai';
        return autoMappedKeys.includes(key);
    };

    // Newly-added custom rows are held LOCALLY until they have a name + value.
    // For tool/AI inputs (keepEmptyFields=false) `buildPatch`'s sanitizeInputs
    // strips empty bindings on autosave, so an empty row written straight into
    // `inputs` would flash and vanish on the next save round-trip. Keeping it
    // local until it's non-empty fixes that. (Set / layer_output use
    // keepEmptyFields and persist empty named fields, so they add directly.)
    const [pending, setPending] = useState([]); // [{ id, key, binding }]
    const [focusKey, setFocusKey] = useState(null); // name input to select on mount
    const pidRef = useRef(0);
    const uniqueKey = (base = 'field') => {
        const taken = new Set([...Object.keys(inputs || {}), ...pending.map(p => p.key)]);
        let k = base, n = 1;
        while (taken.has(k)) k = `${base}${++n}`;
        return k;
    };
    const updatePending = (id, patch) => setPending(p => p.map(r => (r.id === id ? { ...r, ...patch } : r)));
    const removePending = (id) => setPending(p => p.filter(r => r.id !== id));
    // Commit a local row into `inputs` once it has a key + a non-empty value.
    // Called on blur (focus left the row) so we never remount mid-edit.
    const commitPending = (id) => {
        const row = pending.find(r => r.id === id);
        if (!row) return;
        const key = (row.key || '').trim();
        if (!key || isEmptyBinding(row.binding)) return; // not ready — keep editing
        let finalKey = key, n = 1;
        const taken = new Set(Object.keys(inputs || {}));
        while (taken.has(finalKey)) finalKey = `${key}${++n}`;
        onChange?.({ ...(inputs || {}), [finalKey]: row.binding });
        removePending(id);
    };
    const renderPendingRows = () => pending.map(row => (
        <div
            key={`pending-${row.id}`}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) commitPending(row.id); }}
        >
            <GenericRow
                fieldKey={row.key}
                value={row.binding}
                onChange={(b) => updatePending(row.id, { binding: b })}
                onRename={(k) => updatePending(row.id, { key: k })}
                onRemove={() => removePending(row.id)}
                onFocusField={onFocusField}
                previewSample={previewSample}
            />
        </div>
    ));

    const updateField = (key, binding) => {
        if (autoMappedKeys.includes(key) || aiMappedKeys.includes(key)) setConsumed(s => new Set(s).add(key));
        const next = { ...(inputs || {}) };
        if (isEmptyBinding(binding) && !keepEmptyFields) {
            delete next[key];
        } else {
            // Keep the user's named field even when empty (Set / layer_output):
            // normalise to an empty literal so it persists through save.
            next[key] = binding || { kind: 'literal', value: '' };
        }
        onChange?.(next);
    };

    const renameField = (oldKey, newKey) => {
        const cleaned = String(newKey || '').trim();
        if (!cleaned || cleaned === oldKey) return;
        const next = {};
        for (const [k, v] of Object.entries(inputs || {})) {
            next[k === oldKey ? cleaned : k] = v;
        }
        onChange?.(next);
    };

    const removeField = (key) => {
        const next = { ...(inputs || {}) };
        delete next[key];
        onChange?.(next);
    };

    const addField = () => {
        if (keepEmptyFields) {
            // Set / layer_output: empty NAMED fields are valid and persist.
            const next = { ...(inputs || {}) };
            const key = uniqueKey();
            next[key] = { kind: 'literal', value: '' };
            // Focus + select the generated name so the first thing the user
            // types replaces it. Without this the row reads as a box labelled
            // "field" whose meaning nobody explained.
            setFocusKey(key);
            onChange?.(next);
            return;
        }
        // Tool / AI inputs: hold the new row locally until it has a value, so
        // the autosave's empty-strip can't make it flash-and-vanish.
        setPending(p => [...p, { id: ++pidRef.current, key: uniqueKey(), binding: { kind: 'literal', value: '' } }]);
    };

    // "Add field from a previous step" (Set / layer_output only): pick an
    // upstream value and land a named ref field in one click — name suggested
    // from the path's last segment, value already bound.
    const upstreamPicker = useVariablePicker();
    const upstreamCtx = useVariablePickerContext();
    const addFieldFromUpstream = (path) => {
        const key = uniqueKey(suggestKeyFromPath(path));
        onChange?.({ ...(inputs || {}), [key]: { kind: 'ref', path: canonicalRefPath(path) } });
        upstreamPicker.closePicker();
    };
    const AddFromStepButton = keepEmptyFields ? (
        <>
            <button
                type="button"
                onClick={(e) => upstreamPicker.openPicker(e.currentTarget)}
                className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
                <Workflow size={12} /> Add field from a previous step
            </button>
            <VariablePicker
                {...upstreamPicker.pickerProps}
                groups={upstreamCtx.groups}
                previewSample={previewSample ?? upstreamCtx.previewSample}
                onPick={addFieldFromUpstream}
                title="Add field from a previous step"
            />
        </>
    ) : null;

    const WandButton = onAutoMap ? (
        <button
            type="button"
            onClick={onAutoMap}
            title="Auto-map empty inputs from upstream steps"
            className={actionButtonClass()}
        >
            <Sparkles size={12} /> Auto-map
        </button>
    ) : null;

    if (properties) {
        const { essentialKeys, advancedKeys } = partitionInputs(properties, required, inputs);
        const knownKeys = new Set(Object.keys(properties));
        const extras = Object.keys(inputs || {}).filter(k => !knownKeys.has(k));
        const advAutoCount = advancedKeys.filter(isAuto).length;

        const renderField = (key) => (
            <ToolParamField
                key={key}
                fieldKey={key}
                prop={properties[key]}
                required={required.has(key)}
                value={(inputs || {})[key] ?? null}
                onChange={(b) => updateField(key, b)}
                visual={visualValues}
                allowRaw={allowRawValues}
                onFocusField={onFocusField}
                previewSample={previewSample}
                autoMapped={isAuto(key)}
                onRequestForEach={onRequestForEach}
                deepenForEach={deepenForEach}
                suggestion={suggestions?.[key] || null}
                tool={tool}
                problem={problemKey === key ? problemText : null}
            />
        );

        // Only worth a line when there is something left to fill: with every
        // input bound it was a lone button above a finished form.
        const anyEmpty = [...essentialKeys, ...advancedKeys].some(k => isEmptyBinding((inputs || {})[k]));
        return (
            <div className="space-y-5">
                {WandButton && anyEmpty && <div className="flex justify-end">{WandButton}</div>}
                {essentialKeys.map(renderField)}
                {advancedKeys.length > 0 && (
                    <MoreOptions
                        labels={advancedKeys.map(k => properties[k]?.title || k)}
                        autoCount={advAutoCount}
                        open={advFieldsOpen || advancedKeys.includes(problemKey)}
                        onToggle={setAdvFieldsOpen}
                    >
                        {advancedKeys.map(renderField)}
                    </MoreOptions>
                )}
                {(extras.length > 0 || pending.length > 0) && (
                    <div className="pt-2 border-t border-[var(--border-default)] space-y-2">
                        <div className={subLabelClass()}>
                            Extra inputs (not in tool schema)
                        </div>
                        {extras.map(k => (
                            <GenericRow
                                key={k}
                                fieldKey={k}
                                value={inputs[k]}
                                visual={visualValues}
                                allowRaw={allowRawValues}
                                onChange={(b) => updateField(k, b)}
                                onRename={(n) => renameField(k, n)}
                                onRemove={() => removeField(k)}
                                onFocusField={onFocusField}
                                previewSample={previewSample}
                            />
                        ))}
                        {renderPendingRows()}
                    </div>
                )}
                {allowExtraFields && (
                    <button
                        type="button"
                        onClick={addField}
                        className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <Plus size={12} /> Add custom field
                    </button>
                )}
            </div>
        );
    }

    // Generic mode — no schema.
    const entries = Object.entries(inputs || {});
    return (
        <div className="space-y-2">
            {WandButton && <div className="flex justify-end">{WandButton}</div>}
            {entries.length === 0 && pending.length === 0 && (
                <div className="text-[11px] text-[var(--text-tertiary)] italic">
                    No inputs yet. Add a field below.
                </div>
            )}
            {entries.map(([k, v]) => (
                <GenericRow
                    key={k}
                    fieldKey={k}
                    siblingKeys={entries.map(([ek]) => ek).filter(ek => ek !== k)}
                    value={v}
                    visual={visualValues}
                    nameLabel={nameLabel}
                    valueLabel={valueLabel}
                    namePlaceholder={namePlaceholder}
                    valuePlaceholder={valuePlaceholder}
                    allowRaw={allowRawValues}
                    autoFocusName={k === focusKey}
                    onChange={(b) => updateField(k, b)}
                    onRename={(n) => renameField(k, n)}
                    // A path dropped/typed into the NAME slot means "bind this
                    // value": name = last segment, value = ref to the path
                    // (only when the row's value is still empty — never
                    // clobber a configured binding).
                    onAdoptPath={(path, suggested) => {
                        const nextKey = suggested && !Object.prototype.hasOwnProperty.call(inputs || {}, suggested) ? suggested : `${suggested || 'field'}_2`;
                        const cur = (inputs || {})[k];
                        const next = {};
                        for (const [ek, ev] of Object.entries(inputs || {})) {
                            if (ek === k) next[nextKey] = isEmptyBinding(cur) ? { kind: 'ref', path: canonicalRefPath(path) } : ev;
                            else next[ek] = ev;
                        }
                        onChange?.(next);
                    }}
                    onRemove={() => removeField(k)}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    autoMapped={isAuto(k)}
                />
            ))}
            {renderPendingRows()}
            {allowExtraFields && (
                <div className="flex items-center gap-3 flex-wrap">
                    <button
                        type="button"
                        onClick={addField}
                        className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <Plus size={12} /> Add field
                    </button>
                    {AddFromStepButton}
                </div>
            )}
        </div>
    );
}
