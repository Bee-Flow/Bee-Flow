import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { updateNodeProps } from '../../state/definitionOps';
import { actionOptions } from '../actionLabels';
import { registerInspector } from '../registry';
import BindingField from './BindingField';
import { TextField , usePatch } from './kit';

/**
 * Content panel for repeater. Props mirror componentSpecs.js (authoritative).
 *
 * The repeater keeps its array binding in props.source (the schema), but
 * AppRenderer repeats children off the node-level `forEach` field. So editing
 * the source ALSO mirrors it into node.forEach, which is what makes
 * AppRenderer's per-item scope mechanism kick in on the live draft.
 */

/** Immutable rewrite that mirrors the source binding into node.forEach. */
function mirrorForEach(def, nodeId, binding) {
    let changed = false;
    const mapNodes = (nodes) => (nodes || []).map((n) => {
        if (n.id === nodeId) {
            if (JSON.stringify(n.forEach) === JSON.stringify(binding)) return n;
            changed = true;
            return { ...n, forEach: binding };
        }
        if (Array.isArray(n.children)) {
            const kids = mapNodes(n.children);
            if (kids !== n.children) return { ...n, children: kids };
        }
        return n;
    });
    const screens = (def.screens || []).map((screen) => ({
        ...screen,
        sections: (screen.sections || []).map((section) => {
            const kids = mapNodes(section.children);
            return kids === section.children ? section : { ...section, children: kids };
        }),
    }));
    return changed ? { ...def, screens } : def;
}

export default function RepeaterInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    // A raw 'act_a1b2c3' told the author nothing — naming each action the way
    // the Actions accordion names it is the difference between choosing and guessing.
    const actions = actionOptions(definition);
    const actionIds = actions.map((a) => a.id);

    const setSource = (v) => {
        let next = updateNodeProps(definition, node.id, { source: v });
        next = mirrorForEach(next, node.id, v);
        if (next !== definition) onCommit(next);
    };
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label={t('studio_apps_panels.common.source', 'Source')}
                value={props.source}
                onChange={setSource}
                definition={definition}
                hint={t('studio_apps_panels.repeater.source_hint', 'An array — the child components repeat once per item. `item` and `index` are in scope inside.')}
                placeholder='[{"name":"…"}]'
                disabled={disabled}
            />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.repeater.item_actions', 'Item actions')}
                    items={props.itemActions || []}
                    onChange={(itemActions) => patch({ itemActions })}
                    makeNew={() => ({ label: '', actionId: actionIds[0] || '' })}
                    addLabel={t('studio_apps_panels.repeater.add_item_action', 'Add item action')}
                    itemLabel={(a) => a.label}
                    renderItem={(a, update) => (
                        <div className="flex flex-col gap-2">
                            <input type="text" className={inputCls} value={a.label || ''} onChange={(e) => update({ ...a, label: e.target.value })} placeholder={t('studio_apps_panels.common.button_label', 'Button label')} />
                            <select className={inputCls} value={a.actionId || ''} onChange={(e) => update({ ...a, actionId: e.target.value })} aria-label={t('studio_apps_panels.repeater.item_action', 'Item action')}>
                                <option value="">{t('studio_apps_panels.common.pick_action', 'Pick an action…')}</option>
                                {actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                            </select>
                        </div>
                    )}
                />
            </fieldset>
            <TextField label={t('studio_apps_panels.common.empty_text', 'Empty text')} value={props.emptyText} onChange={(v) => patch({ emptyText: v })} disabled={disabled} />
        </div>
    );
}

registerInspector('repeater', RepeaterInspector);
