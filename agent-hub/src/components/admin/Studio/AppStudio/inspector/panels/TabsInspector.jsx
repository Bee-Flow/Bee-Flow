import { Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import ConfirmDialog from '../../../../../shared/ConfirmDialog';
import IconButton from '../../../../../shared/IconButton';
import { getComponentEntry } from '../../runtime/componentRegistry';
import { insertNode, removeNode, updateNodeProps } from '../../state/definitionOps';
import { registerInspector } from '../registry';
import { IconField, TextField, SelectField, usePatch } from './kit';

// Mirror of the tabs `look` enum (componentSpecs.js, authoritative — first
// value is the default: the bottom-ruled strip with a primary underline on
// the active tab, exactly what tabs always rendered).
/** Build a fresh `tab` node from the registry defaults (deep-cloned). */
function newTabNode() {
    const entry = getComponentEntry('tab');
    return {
        type: 'tab',
        visible: true,
        props: JSON.parse(JSON.stringify(entry?.defaultProps || { label: 'Tab', icon: null })),
        style: JSON.parse(JSON.stringify(entry?.defaultStyle || { gap: 3, padding: 0 })),
        children: [],
    };
}

/** Content panel for the `tabs` container — its look, plus add / rename / remove its tabs. */
export function TabsInspector({ node, definition, onCommit, disabled = false }) {
    const { t } = useTranslation();
    const LOOKS = [
        { value: 'underline', label: t('studio_apps_panels.tabs.look_underline', 'Underline') },
        { value: 'pills', label: t('studio_apps_panels.tabs.look_pills', 'Pills') },
        { value: 'boxed', label: t('studio_apps_panels.tabs.look_boxed', 'Boxed') },
    ];
    const tabs = Array.isArray(node.children) ? node.children : [];
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);

    const addTab = () => {
        const { def, nodeId } = insertNode(definition, { parentId: node.id, node: newTabNode() });
        if (nodeId) onCommit(def);
    };
    const renameTab = (tabId, label) => {
        const next = updateNodeProps(definition, tabId, { label });
        if (next !== definition) onCommit(next);
    };
    // Selecting the tab node and using the header trash asks first when it holds
    // anything (InspectorPanel's ConfirmDialog); this row did not, and it is the
    // faster route — a "Details" tab with a ten-field form vanished on one click
    // with nothing but the editor-wide undo to get it back.
    const [confirmTabId, setConfirmTabId] = useState(null);
    const confirmTab = tabs.find((tb) => tb.id === confirmTabId) || null;
    const childCount = Array.isArray(confirmTab?.children) ? confirmTab.children.length : 0;

    const doDeleteTab = (tabId) => {
        setConfirmTabId(null);
        const next = removeNode(definition, tabId);
        if (next !== definition) onCommit(next);
    };
    const deleteTab = (tab) => {
        const hasChildren = Array.isArray(tab?.children) && tab.children.length > 0;
        if (hasChildren) setConfirmTabId(tab.id);
        else doDeleteTab(tab.id);
    };

    return (
        <div className="flex flex-col gap-3">
            <SelectField
                label={t('studio_apps_panels.common.look', 'Look')}
                value={props.look ?? 'underline'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />
            <div className="flex flex-col gap-2">
                {tabs.map((tab, i) => (
                    <div key={tab.id || i} className="flex items-center gap-2">
                        <input
                            type="text"
                            className="flex-1 px-3 py-2 rounded-md text-sm border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] focus:border-[var(--accent-primary)]"
                            value={tab.props?.label || ''}
                            onChange={(e) => renameTab(tab.id, e.target.value)}
                            placeholder={t('studio_apps_panels.tabs.tab_placeholder', 'Tab {n}', { n: i + 1 })}
                            disabled={disabled}
                            aria-label={t('studio_apps_panels.tabs.tab_label_aria', 'Tab {n} label', { n: i + 1 })}
                        />
                        <IconButton ariaLabel={t('studio_apps_panels.tabs.delete_tab_aria', 'Delete tab {n}', { n: i + 1 })} variant="danger" onClick={() => deleteTab(tab)} disabled={disabled || tabs.length <= 1}>
                            <Trash2 />
                        </IconButton>
                    </div>
                ))}
            </div>
            <button
                type="button"
                onClick={addTab}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-50"
            >
                <Plus className="w-3.5 h-3.5" /> {t('studio_apps_panels.tabs.add_tab', 'Add tab')}
            </button>

            <ConfirmDialog
                open={!!confirmTab}
                title={t('studio_apps_panels.tabs.delete_title', 'Delete the “{name}” tab?', { name: confirmTab?.props?.label || t('studio_apps_panels.tabs.delete_fallback_name', 'tab') })}
                description={childCount === 1 ? t('studio_apps_panels.tabs.delete_desc_one', 'It holds 1 component — everything inside it will be deleted too.') : t('studio_apps_panels.tabs.delete_desc_many', 'It holds {n} components — everything inside it will be deleted too.', { n: childCount })}
                confirmLabel={t('studio_apps_panels.common.delete', 'Delete')}
                destructive
                onConfirm={() => doDeleteTab(confirmTabId)}
                onCancel={() => setConfirmTabId(null)}
            />
        </div>
    );
}

/** Content panel for a single `tab` — its label + icon. */
export function TabInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);
    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.tabs.tab_label', 'Tab label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <IconField label={t('studio_apps_panels.tabs.tab_icon', 'Tab icon')} value={props.icon} onChange={(v) => patch({ icon: v })} disabled={disabled} />
        </div>
    );
}

registerInspector('tabs', TabsInspector);
registerInspector('tab', TabInspector);

export default TabsInspector;
