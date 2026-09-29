import React, { useEffect, useEffectEvent, useState } from 'react';
import { KeyRound, RefreshCw, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection, DrawerId } from '../../../../shared/SideDrawer';
import FindingRow from '../../../../shared/FindingRow';
import ArticleRef from '../../shared/ArticleRef';
import { Select, Toggle, ActionButton, INPUT_CLASS, Fact } from '../audits/auditForms';

/**
 * ConnectorDrawer — the editor for one ISO evidence connector.
 *
 * Credentials live in the integration-connections vault; a connector only ever
 * references one, so this drawer picks a connection, never a secret. The
 * settings box is raw JSON (the connector families each want their own keys);
 * invalid JSON refuses to save rather than writing `{}` over what was there.
 *
 * Handlers are the legacy page's, under the hub's names:
 * `onLoadConnections(id)`, `onSave(id, patch)`, `onSweep(id)`.
 */
function draftOf(connector) {
    if (!connector) return null;
    return {
        enabled: !!connector.config?.enabled,
        connection_id: connector.config?.connection_id || '',
        settingsText: JSON.stringify(connector.config?.settings || {}, null, 2),
    };
}

export default function ConnectorDrawer({
    connector, busy = false, onLoadConnections, onSave, onSweep, onClose, mode = 'inline',
}) {
    const { t } = useTranslation();
    const id = connector?.id || null;
    const cfg = connector?.config || null;

    const [draft, setDraft] = useState(() => draftOf(connector));
    const [connections, setConnections] = useState([]);
    const [settingsError, setSettingsError] = useState(false);

    // A fresh draft when another connector opens — during render, keyed on its
    // id, so typing survives re-renders of the same connector.
    const [seenId, setSeenId] = useState(id);
    if (seenId !== id) {
        setSeenId(id);
        setSettingsError(false);
        setDraft(draftOf(connector));
        setConnections([]);
    }

    const loadConnections = useEffectEvent(async (isAlive) => {
        if (!connector?.credential || typeof onLoadConnections !== 'function') return;
        try {
            const list = await onLoadConnections(connector.id);
            if (isAlive()) setConnections(Array.isArray(list) ? list : []);
        } catch { if (isAlive()) setConnections([]); }
    });
    useEffect(() => {
        let alive = true;
        loadConnections(() => alive);
        return () => { alive = false; };
    }, [id]);

    if (!connector || !draft) return null;

    const save = () => {
        let settings;
        try { settings = JSON.parse(draft.settingsText || '{}'); }
        catch { setSettingsError(true); return; }
        setSettingsError(false);
        onSave?.(connector.id, {
            enabled: draft.enabled,
            connection_id: draft.connection_id || null,
            settings,
        });
    };

    return (
        <SideDrawer
            open
            onClose={onClose}
            mode={mode}
            width={420}
            ariaLabel={t(connector.titleKey, connector.titleKey)}
            testId="connector-drawer"
            header={(
                <div className="flex flex-col gap-1 min-w-0">
                    <DrawerId testId="connector-drawer-id">{connector.id}</DrawerId>
                    <span className="text-sm font-bold text-[var(--text-primary)] truncate">{t(connector.titleKey, connector.titleKey)}</span>
                    {Array.isArray(connector.covered_controls) && connector.covered_controls.length > 0 && (
                        <ArticleRef testId="connector-drawer-controls">{connector.covered_controls.join(' · ')}</ArticleRef>
                    )}
                </div>
            )}
            footer={(
                <div className="flex items-center gap-2 flex-wrap">
                    <ActionButton variant="primary" icon={CheckCircle2} disabled={busy} onClick={save} data-testid="connector-drawer-save">
                        {t('compliance.conn_save', 'Save')}
                    </ActionButton>
                    {cfg?.enabled && (
                        <ActionButton icon={RefreshCw} disabled={busy} onClick={() => onSweep?.(connector.id)} data-testid="connector-drawer-sweep">
                            {t('compliance.conn_sweep_now', 'Sweep now')}
                        </ActionButton>
                    )}
                </div>
            )}
        >
            <p className="m-0 text-xs text-[var(--text-secondary)]" data-testid="connector-drawer-desc">
                {t(connector.descKey, connector.descKey)}
            </p>

            {cfg?.last_error && (
                <FindingRow
                    severity="error"
                    message={cfg.last_error}
                    testId="connector-drawer-error"
                />
            )}

            <Toggle
                checked={draft.enabled}
                onChange={(v) => setDraft(d => ({ ...d, enabled: v }))}
                label={t('compliance.conn_enabled', 'Collect evidence from this system')}
                testId="connector-drawer-enabled"
            />

            {connector.credential && (
                <DrawerSection
                    label={t('compliance.conn_connection', 'Connection')}
                    hint={t('compliance.conn_connection_hint', 'Create a "{provider}" connection under Integrations first.', { provider: connector.credential.provider })}
                >
                    <div className="flex items-center gap-1.5">
                        <KeyRound size={12} aria-hidden="true" className="text-[var(--text-tertiary)]" />
                        <Select
                            value={draft.connection_id}
                            onChange={(v) => setDraft(d => ({ ...d, connection_id: v }))}
                            data-testid="connector-drawer-connection"
                            options={[
                                { value: '', label: t('compliance.conn_connection_none', 'No connection') },
                                ...connections.map(c => ({ value: c.id, label: `${c.label || c.id} (${c.kind})` })),
                            ]}
                        />
                    </div>
                </DrawerSection>
            )}

            <DrawerSection label={t('compliance.conn_settings', 'Settings (JSON)')} hint={connector.settings_hint || null}>
                <textarea
                    value={draft.settingsText}
                    rows={5}
                    spellCheck={false}
                    placeholder={connector.settings_hint ? `{ ${connector.settings_hint} }` : '{}'}
                    aria-label={t('compliance.conn_settings', 'Settings (JSON)')}
                    onChange={e => setDraft(d => ({ ...d, settingsText: e.target.value }))}
                    className={`${INPUT_CLASS} font-mono text-[11.5px] resize-y`}
                    style={settingsError ? { borderColor: 'var(--error)' } : undefined}
                    data-testid="connector-drawer-settings"
                />
                {settingsError && (
                    <span className="text-[11px] text-[var(--error-ink)]" data-testid="connector-drawer-settings-invalid">
                        {t('compliance.conn_settings_invalid', 'That is not valid JSON — nothing was saved.')}
                    </span>
                )}
            </DrawerSection>

            {cfg?.last_sweep_at && (
                <Fact label={t('compliance.conn_col_last', 'Last sweep')} testId="connector-drawer-last">
                    {new Date(cfg.last_sweep_at).toLocaleString()}
                </Fact>
            )}
        </SideDrawer>
    );
}
