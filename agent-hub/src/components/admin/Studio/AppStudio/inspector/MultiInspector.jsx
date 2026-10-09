import { Copy, Layers, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { SelectField } from './panels/kit';
import { STYLE_KNOBS, getKnobsForType, clampKnob, knobLabel, valueLabel } from './styleKnobMeta';
import TokenColorField from './TokenColorField';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import IconButton from '../../../../shared/IconButton';
import FormField from '../../../../shared/FormField';
import SegmentedControl from '../../../../shared/SegmentedControl';
import Slider from '../../../../shared/Slider';
import { duplicateNode, findNode, removeNode, updateNodeStyle } from '../state/definitionOps';

/**
 * MultiInspector — the inspector body shown when more than one node is
 * selected. It exposes the style knobs COMMON to every selected type (the
 * intersection of each type's knob list) and applies each change to ALL
 * selected nodes in a single history commit, plus bulk duplicate/delete.
 *
 * A knob whose value differs across the selection reads "Mixed" until you set
 * it; setting it writes the same value to every node.
 */

const INHERIT = '__inherit';

function enumOptions(t, knob) {
    return STYLE_KNOBS[knob].values.map((v) => (
        v === null ? { value: INHERIT, label: t('studio_apps_insp.multi.inherit', 'Inherit') } : { value: v, label: valueLabel(v, t) }
    ));
}

/** Common knobs across a set of component types (order from the first type). */
export function commonKnobs(types) {
    const lists = (types || []).map(getKnobsForType).filter((l) => l.length);
    if (!lists.length) return [];
    return lists.reduce((acc, list) => acc.filter((k) => list.includes(k)));
}

/** The shared value of `knob` across nodes, or undefined when they disagree. */
export function sharedValue(nodes, knob) {
    let seen;
    let has = false;
    for (const node of nodes) {
        const v = node.style?.[knob] !== undefined ? node.style[knob] : STYLE_KNOBS[knob]?.default;
        if (!has) { seen = v; has = true; }
        else if (!Object.is(seen, v)) return undefined; // mixed
    }
    return has ? seen : undefined;
}

export default function MultiInspector({ definition, ids, onCommit, disabled, dispatch }) {
    const { t } = useTranslation();
    const mixedSuffix = t('studio_apps_insp.multi.mixed_suffix', ' · Mixed');
    const nodes = (ids || [])
        .map((id) => findNode(definition, id)?.node)
        .filter(Boolean);
    const knobs = commonKnobs(nodes.map((n) => n.type));

    const commitKnob = (knob, rawValue) => {
        const value = clampKnob(knob, rawValue);
        let def = definition;
        for (const node of nodes) def = updateNodeStyle(def, node.id, { [knob]: value });
        if (def !== definition) onCommit(def);
    };

    const doDuplicate = () => {
        let def = definition;
        const newIds = [];
        for (const node of nodes) {
            const res = duplicateNode(def, node.id);
            if (res.nodeId) { def = res.def; newIds.push(res.nodeId); }
        }
        if (def !== definition) onCommit(def);
        if (newIds.length) dispatch?.({ type: 'select_many', ids: newIds });
    };

    // Deleting one container asks first (InspectorPanel's ConfirmDialog);
    // deleting five of them from here did not ask at all, and a bulk delete is
    // the case where the most is at stake — a selected Card takes its whole
    // subtree with it and nothing on screen said so.
    const [confirming, setConfirming] = useState(false);
    const withChildren = nodes.filter((n) => Array.isArray(n.children) && n.children.length > 0);

    const doRemove = () => {
        setConfirming(false);
        let def = definition;
        for (const node of nodes) def = removeNode(def, node.id);
        if (def !== definition) onCommit(def);
        dispatch?.({ type: 'clear_selection' });
    };
    const bulkRemove = () => (withChildren.length ? setConfirming(true) : doRemove());

    return (
        <div className="p-4 flex flex-col gap-3">
            <header className="flex items-center gap-2">
                <Layers className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate flex-1">
                    {t('studio_apps_insp.multi.selected', '{count} selected', { count: nodes.length })}
                </h2>
                <IconButton ariaLabel={t('studio_apps_insp.multi.duplicate_selected', 'Duplicate selected')} onClick={doDuplicate} disabled={disabled}>
                    <Copy />
                </IconButton>
                <IconButton ariaLabel={t('studio_apps_insp.multi.delete_selected', 'Delete selected')} variant="danger" onClick={bulkRemove} disabled={disabled}>
                    <Trash2 />
                </IconButton>
            </header>

            {knobs.length ? (
                <div className="flex flex-col gap-4">
                    {knobs.map((knob) => {
                        const spec = STYLE_KNOBS[knob];
                        if (!spec) return null;
                        const shared = sharedValue(nodes, knob);
                        const mixed = shared === undefined;

                        if (spec.type === 'int') {
                            return (
                                <Slider
                                    key={knob}
                                    label={`${knobLabel(knob, t)}${mixed ? mixedSuffix : ''}`}
                                    value={Number.isFinite(shared) ? shared : spec.default}
                                    onChange={(v) => commitKnob(knob, v)}
                                    min={spec.min}
                                    max={spec.max}
                                    step={spec.step}
                                    suffix={knob === 'span' ? t('studio_apps_insp.multi.col_suffix', ' col') : ''}
                                    disabled={disabled}
                                />
                            );
                        }
                        if (spec.type === 'colorOrRole') {
                            return (
                                <FormField key={knob} label={`${knobLabel(knob, t)}${mixed ? mixedSuffix : ''}`}>
                                    <TokenColorField
                                        value={mixed ? null : shared}
                                        onChange={(v) => commitKnob(knob, v)}
                                        themePrimary={definition?.theme?.primary || null}
                                        disabled={disabled}
                                    />
                                </FormField>
                            );
                        }
                        // Background outgrew a segmented row when the look
                        // pass appended panel/gradient (see StyleSection) —
                        // same house select here, with a disabled "Mixed"
                        // placeholder until one value is picked for all.
                        if (knob === 'background') {
                            const opts = mixed
                                ? [{ value: '', label: t('studio_apps_insp.multi.mixed', 'Mixed'), disabled: true }, ...enumOptions(t, knob)]
                                : enumOptions(t, knob);
                            return (
                                <SelectField
                                    key={knob}
                                    label={`${knobLabel(knob, t)}${mixed ? mixedSuffix : ''}`}
                                    value={mixed ? '' : shared}
                                    onChange={(v) => commitKnob(knob, v)}
                                    options={opts}
                                    disabled={disabled}
                                    ariaLabel={knobLabel(knob, t)}
                                />
                            );
                        }
                        return (
                            <FormField key={knob} label={`${knobLabel(knob, t)}${mixed ? mixedSuffix : ''}`}>
                                <SegmentedControl
                                    value={mixed ? null : (shared === null ? INHERIT : shared)}
                                    onChange={(v) => commitKnob(knob, v === INHERIT ? null : v)}
                                    options={enumOptions(t, knob)}
                                    size="sm"
                                    fullWidth
                                    disabled={disabled}
                                    ariaLabel={knobLabel(knob, t)}
                                />
                            </FormField>
                        );
                    })}
                </div>
            ) : (
                <p className="text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_insp.multi.no_common_knobs', 'These components don’t share adjustable style options. Use the toolbar to duplicate or delete them together.')}
                </p>
            )}

            <ConfirmDialog
                open={confirming}
                title={t('studio_apps_insp.multi.delete_title', 'Delete {count} components?', { count: nodes.length })}
                description={
                    withChildren.length === 1
                        ? t('studio_apps_insp.multi.delete_one_holds', 'One of them holds other components — everything inside it will be deleted too.')
                        : t('studio_apps_insp.multi.delete_many_hold', '{count} of them hold other components — everything inside those will be deleted too.', { count: withChildren.length })
                }
                confirmLabel={t('studio_apps_insp.multi.delete', 'Delete')}
                destructive
                onConfirm={doRemove}
                onCancel={() => setConfirming(false)}
            />
        </div>
    );
}
