import { KeyRound, RefreshCw, CheckCircle2 } from 'lucide-react';
import React, { useEffect, useEffectEvent, useState } from 'react';
import { connectorState, statusLabel, toneOfConnector } from './connectorStatus';
import { useTranslation } from '../../../../../hooks/useTranslation';
import FindingRow from '../../../../shared/FindingRow';
import SideDrawer, { DrawerSection, DrawerFooter } from '../../../../shared/SideDrawer';
import ArticleRef from '../../shared/ArticleRef';
import StatusPill from '../../shared/StatusPill';
import { Select, Toggle, ActionButton, INPUT_CLASS, Fact, fmtStamp } from '../audits/auditForms';

/**
 * ConnectorDrawer — the editor for one ISO evidence connector.
 *
 * Credentials live in the integration-connections vault; a connector only ever
 * references one, so this drawer picks a connection, never a secret. A linked
 * connection that the vault no longer lists stays visible as its own option,
 * "Linked connection not found (id)" in warning ink, instead of the select
 * silently reading "No connection linked". The settings box is raw JSON (the
 * connector families each want their own keys): it starts EMPTY when there
 * are no settings, so the placeholder shows the connector's example, and
 * invalid JSON refuses to save rather than writing `{}` over what was there.
 *
 * The header carries the status (connectorStatus, the same words as the
 * table); the connector's id is the title's tooltip. Actions sit in the
 * DrawerFooter: Sweep now on the left while the connector is on, Save on
 * the right.
 *
 * Handlers are the legacy page's, under the hub's names:
 * `onLoadConnections(id)`, `onSave(id, patch)`, `onSweep(id)`.
 */
export const CONNECTOR_DRAWER_WIDTH = 420;

function settingsTextOf(settings) {
    if (!settings || typeof settings !== 'object' || Object.keys(settings).length === 0) return '';
    return JSON.stringify(settings, null, 2);
}

function draftOf(connector) {
    if (!connector) return null;
    return {
        enabled: !!connector.config?.enabled,
        connection_id: connector.config?.connection_id || '',
        settingsText: settingsTextOf(connector.config?.settings),
    };
}

export default function ConnectorDrawer({
    connector, busy = false, onLoadConnections, onSave, onSweep, onClose, mode = 'inline',
}) {
    const { t, resolvedLocale } = useTranslation();
    const id = connector?.id || null;
    const cfg = connector?.config || null;

    const [draft, setDraft] = useState(() => draftOf(connector));
    const [connections, setConnections] = useState([]);
    const [connectionsRead, setConnectionsRead] = useState(false);
    const [settingsError, setSettingsError] = useState(false);

    // A fresh draft when another connector opens — during render, keyed on its
    // id, so typing survives re-renders of the same connector.
    const [seenId, setSeenId] = useState(id);
    if (seenId !== id) {
        setSeenId(id);
        setSettingsError(false);
        setDraft(draftOf(connector));
        setConnections([]);
        setConnectionsRead(false);
    }

    const loadConnections = useEffectEvent(async (isAlive) => {
        if (!connector?.credential || typeof onLoadConnections !== 'function') return;
        try {
            const list = await onLoadConnections(connector.id);
            if (isAlive()) { setConnections(Array.isArray(list) ? list : []); setConnectionsRead(true); }
        } catch { if (isAlive()) setConnections([]); }
    });
    useEffect(() => {
        let alive = true;
        loadConnections(() => alive);
        return () => { alive = false; };
    }, [id]);

    if (!connector || !draft) return null;

    const title = t(connector.titleKey, connector.titleKey);
    const linked = draft.connection_id;
    // Only once the vault answered can a linked id be called "not found";
    // before that (or when the read failed) the option shows the bare id.
    const linkedMissing = !!linked && !connections.some(c => String(c.id) === String(linked));
    const missingOption = linkedMissing ? [{
        value: linked,
        label: connectionsRead ? t('compliance.conn_connection_missing', 'Linked connection not found ({id})', { id: linked }) : String(linked),
    }] : [];

    const save = () => {
        let settings;
        try { settings = JSON.parse(draft.settingsText.trim() || '{}'); }
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
            width={CONNECTOR_DRAWER_WIDTH}
            ariaLabel={title}
            testId="connector-drawer"
            header={(
                <div className="flex flex-col gap-1 min-w-0">
                    <span className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span className="text-sm font-bold text-[var(--text-primary)] min-w-0 [overflow-wrap:anywhere]" title={connector.id} data-testid="connector-drawer-title">{title}</span>
                        <StatusPill tone={toneOfConnector(cfg)} testId="connector-drawer-status">{statusLabel(t, cfg)}</StatusPill>
                    </span>
                    {Array.isArray(connector.covered_controls) && connector.covered_controls.length > 0 && (
                        <ArticleRef testId="connector-drawer-controls">{connector.covered_controls.join(' · ')}</ArticleRef>
                    )}
                </div>
            )}
            footer={(
                <DrawerFooter
                    testId="connector-drawer-foot"
                    onPrimary={save}
                    primaryLabel={t('compliance.conn_save', 'Save connector')}
                    primaryIcon={CheckCircle2}
                    primaryDisabled={busy}
                >
                    {cfg?.enabled && (
                        <ActionButton icon={RefreshCw} disabled={busy} onClick={() => onSweep?.(connector.id)} data-testid="connector-drawer-sweep">
                            {t('compliance.conn_sweep_now', 'Sweep now')}
                        </ActionButton>
                    )}
                </DrawerFooter>
            )}
        >
            <p className="m-0 text-xs text-[var(--text-secondary)]" data-testid="connector-drawer-desc">
                {t(connector.descKey, connector.descKey)}
            </p>

            {cfg?.last_error && (
                <FindingRow
                    size="sm"
                    severity={connectorState(cfg) === 'failed' ? 'error' : 'warning'}
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
                            className="data-[missing=true]:text-[var(--warning-ink)]"
                            data-testid="connector-drawer-connection"
                            data-missing={linkedMissing && connectionsRead ? 'true' : undefined}
                            options={[
                                ...missingOption,
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
                    aria-invalid={settingsError || undefined}
                    onChange={e => setDraft(d => ({ ...d, settingsText: e.target.value }))}
                    className={`${INPUT_CLASS} font-mono text-[11.5px] resize-y aria-invalid:border-[var(--error)]`}
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
                    {fmtStamp(cfg.last_sweep_at, resolvedLocale || 'en')}
                </Fact>
            )}
        </SideDrawer>
    );
}
