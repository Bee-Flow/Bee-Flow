import React, { useMemo, useState } from 'react';
import useIntegrationCatalog from './useIntegrationCatalog';
import useTranslation from '../../../../../hooks/useTranslation';
import AppActionPicker from '../../../../shared/AppActionPicker';
import Modal from '../../../../shared/Modal';

/**
 * App Studio — pick apps and actions for connectors, in bulk.
 *
 * Replaces the two bare <select>s that used to mean one connector per action,
 * hand-created one at a time. This is the SAME overlay the agent editor uses
 * (shared/AppActionPicker), in multi-select mode: tick the actions you want and
 * one connector is created per tick, named after the action and grouped under
 * its app in the list.
 *
 * The selection is derived from, and applied back to, `model.connectors[]` — one
 * connector still holds exactly one action, so every existing contract (bindings,
 * validation, the runtime, the publish summary) is untouched. Only the authoring
 * cost changed.
 *
 * Props
 *   connectors  — the current model.connectors[] (the source of what's ticked)
 *   onApply     — ({ add: [{ tool, integrationId, name, producesList }], remove: [connectorId] }) => void
 *   onClose     — () => void
 */
export default function ConnectorPicker({ connectors = [], onApply, onClose }) {
    const { t } = useTranslation();
    const { apps, loading, failed, refresh } = useIntegrationCatalog();

    // What is already wired, as action names. Only integration_tool connectors
    // participate — an automation or REST connector has no action to tick.
    const initial = useMemo(
        () => (connectors || []).filter((c) => c?.kind === 'integration_tool' && c.tool).map((c) => c.tool),
        [connectors],
    );
    const [selected, setSelected] = useState(initial);

    const toggle = (name) => {
        setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
    };
    const toggleApp = (app, on, visibleActions) => {
        const names = (visibleActions || app.actions || []).map((a) => a.name);
        setSelected((prev) => (on
            ? [...new Set([...prev, ...names])]
            : prev.filter((n) => !names.includes(n))));
    };

    const apply = () => {
        const before = new Set(initial);
        const after = new Set(selected);
        const byTool = new Map(apps.flatMap((app) => (app.actions || []).map((a) => [a.name, { app, action: a }])));

        const add = selected.filter((name) => !before.has(name)).map((name) => {
            const hit = byTool.get(name);
            return {
                tool: name,
                integrationId: hit?.action?.integrationId || hit?.app?.id || '',
                // A readable default so the list doesn't fill with "Connector 7".
                name: hit ? `${hit.app.label || hit.app.id} — ${hit.action.label || name}` : name,
                producesList: !!hit?.action?.producesList,
            };
        });
        const remove = (connectors || [])
            .filter((c) => c?.kind === 'integration_tool' && c.tool && before.has(c.tool) && !after.has(c.tool))
            .map((c) => c.id);

        onApply?.({ add, remove });
        onClose?.();
    };

    const addedCount = selected.filter((n) => !initial.includes(n)).length;
    const removedCount = initial.filter((n) => !selected.includes(n)).length;
    const dirty = addedCount > 0 || removedCount > 0;

    // The catalog is a hard dependency for THIS picker (unlike the old dropdown,
    // whose escape hatch was a raw text field). Say what happened and offer a
    // retry rather than rendering an empty overlay.
    if (loading || failed || apps.length === 0) {
        return (
            <Modal open onClose={() => onClose?.()} size="md" label={t('studio_apps_bi.picker.modal_label', 'Apps')}>
                <p className="text-sm text-[var(--text-primary)]">
                    {loading ? t('studio_apps_bi.picker.loading', 'Loading your apps…')
                        : failed ? t('studio_apps_bi.picker.failed', 'We couldn’t load your apps just now.')
                            : t('studio_apps_bi.picker.none_connected', 'No apps are connected to your account yet. Connect one in Settings → Integrations.')}
                </p>
                <div className="mt-4 flex items-center gap-2">
                    {!loading && (
                        <button type="button" onClick={refresh} className="rounded-md border px-2.5 py-1.5 text-xs font-medium"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}>
                            {t('studio_apps_bi.picker.check_again', 'Check again')}
                        </button>
                    )}
                    <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1.5 text-xs"
                        style={{ color: 'var(--text-secondary)' }}>
                        {t('studio_apps_bi.picker.close', 'Close')}
                    </button>
                </div>
            </Modal>
        );
    }

    return (
        <AppActionPicker
            apps={apps}
            selected={selected}
            onToggle={toggle}
            onToggleApp={toggleApp}
            onClose={onClose}
            title={t('studio_apps_bi.picker.title', 'Choose apps & actions')}
            emptyLabel={t('studio_apps_bi.picker.empty', 'No apps are connected yet')}
            unavailableHint={t('studio_apps_bi.picker.unavailable_hint', 'not connected to your account, so a connector using it will fail unless it runs with each viewer’s own connection')}
            footer={(
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={apply}
                        disabled={!dirty}
                        className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        {dirty ? t('studio_apps_bi.picker.apply', 'Apply') : t('studio_apps_bi.picker.nothing_to_change', 'Nothing to change')}
                    </button>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {dirty
                            ? [
                                addedCount ? (addedCount === 1 ? t('studio_apps_bi.picker.added_one', '1 connector added') : t('studio_apps_bi.picker.added_many', '{n} connectors added', { n: addedCount })) : null,
                                removedCount ? t('studio_apps_bi.picker.removed', '{n} removed', { n: removedCount }) : null,
                            ].filter(Boolean).join(', ')
                            : t('studio_apps_bi.picker.tick_hint', 'Tick the actions you want — one connector is created per action.')}
                    </span>
                </div>
            )}
        />
    );
}
