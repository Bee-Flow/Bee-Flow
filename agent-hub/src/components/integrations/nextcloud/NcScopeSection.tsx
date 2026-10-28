import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { API_BASE } from '@/utils/helpers';
import { integrationsAdminKeys, useNcScopeQuery } from '@/api/queries/integrationsAdmin';
import { mutate } from '@/api/mutate';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';
import type { DesignElement } from '../../admin/Studio/Playbooks/phaseMachine';
import type { ScopeMap, ScopeBody } from './NcScopeSection.types';
import { MODE_ALL, MODE_SELECTED, MODE_OFF, ScopeRow } from './ScopeRow';

// ── Folder tree (lazy, one PROPFIND level per expansion) ────────────────────

// ── Flat resource picker (calendars, boards, rooms, …) ──────────────────────

// ── One catalog row + its disclosure panel ──────────────────────────────────

// ── The section ─────────────────────────────────────────────────────────────

const NcScopeSection = () => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const scopeQuery = useNcScopeQuery<ScopeMap>(); // { [id]: {name, mode, selected, scopable, resource} }
    const integrations: ScopeMap | null = scopeQuery.data ?? null;
    const setIntegrations = (next: ScopeMap | null | ((cur: ScopeMap | null) => ScopeMap | null)) => {
        queryClient.setQueryData<ScopeMap | null>(integrationsAdminKeys.ncScope, (cur) => (typeof next === 'function' ? next(cur ?? null) : next));
    };
    const loadError: string | null = scopeQuery.isError ? (scopeQuery.error.message || t('nc_scope.load_error', 'Could not load access settings')) : null;
    const [saveState, setSaveState] = useState('idle');     // idle | saving | saved | error
    const [confirmRevoke, setConfirmRevoke] = useState(false);
    const savedTimer = useRef<NodeJS.Timeout | undefined>(undefined);

    const persist = useCallback(async (body: ScopeBody) => {
        setSaveState('saving');
        try {
            const res = await mutate(`${API_BASE}/api/nc-scope`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            queryClient.setQueryData<ScopeMap | null>(integrationsAdminKeys.ncScope, data.integrations ?? null);
            setSaveState('saved');
            clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setSaveState('idle'), 2000);
        } catch (_) {
            setSaveState('error');
        }
    }, [queryClient]);

    const onModeChange = (id: string, mode: string) => {
        // Optimistic words update; the PUT response is authoritative.
        setIntegrations(cur => ({ ...cur, [id]: { ...(cur as ScopeMap)[id], mode } }));
        persist({ integrations: { [id]: mode === MODE_SELECTED ? { mode, selected: integrations?.[id]?.selected || [] } : { mode } } });
    };

    const onSelectionSave = (id: string, selected: string[]) => {
        persist({ integrations: { [id]: { mode: MODE_SELECTED, selected } } });
    };

    const revokeAll = async () => {
        setConfirmRevoke(false);
        setSaveState('saving');
        try {
            const res = await mutate(`${API_BASE}/api/nc-scope/revoke-all`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            setIntegrations(data.integrations ?? null);
            setSaveState('saved');
        } catch (_) { setSaveState('error'); }
    };

    const reset = async () => {
        setSaveState('saving');
        try {
            const res = await mutate(`${API_BASE}/api/nc-scope/reset`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            setIntegrations(data.integrations ?? null);
            setSaveState('saved');
        } catch (_) { setSaveState('error'); }
    };

    if (loadError) return <p className="text-[11px] text-[var(--text-muted)]">{loadError}</p>;
    if (!integrations) {
        return (
            <p className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]" data-testid="nc-scope-loading">
                <Loader2 size={12} className="animate-spin" /> {t('nc_scope.loading', 'Loading…')}
            </p>
        );
    }

    const anyNarrowed = Object.values(integrations).some(e => e.mode !== MODE_ALL);
    const allOff = Object.values(integrations).every(e => e.mode === MODE_OFF);

    return (
        <div data-testid="nc-scope-section">
            <div className="flex items-baseline justify-between mb-2">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('nc_scope.title', 'What Bee Flow may access')}
                </p>
                <span className="text-[11px]" style={{ color: saveState === 'error' ? 'var(--text-primary)' : 'var(--text-tertiary)' }} data-testid="nc-scope-savestate">
                    {saveState === 'saving' ? t('nc_scope.saving', 'Saving…')
                        : saveState === 'saved' ? t('nc_scope.saved', '✓ Saved')
                        : saveState === 'error' ? t('nc_scope.save_error', '⚠ Not saved — try again')
                        : ''}
                </span>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('nc_scope.intro', 'Share parts of your Nextcloud with Bee Flow the way you would with a colleague — and take them back any time. Enforced on the server for chats, automations and apps alike.')}
            </p>
            <div className="rounded-xl overflow-hidden [border:1px_solid_var(--border-subtle)]">
                {Object.entries(integrations).map(([id, entry], i, arr) => (
                    <ScopeRow
                        key={id}
                        id={id}
                        entry={entry}
                        last={i === arr.length - 1}
                        onModeChange={onModeChange}
                        onSelectionSave={onSelectionSave}
                        t={t}
                    />
                ))}
            </div>
            <div className="flex items-center justify-between mt-3">
                <button
                    type="button"
                    onClick={anyNarrowed ? reset : undefined}
                    disabled={!anyNarrowed}
                    className="text-[12px] disabled:opacity-40 text-[var(--text-muted)]"
                    data-testid="nc-scope-reset"
                >
                    {t('nc_scope.reset', 'Reset to default')}
                </button>
                {confirmRevoke ? (
                    <span className="flex items-center gap-2 text-[12px] text-[var(--text-primary)]">
                        {t('nc_scope.revoke_confirm', 'Turn off all Nextcloud access?')}
                        <button type="button" onClick={revokeAll} className="font-medium text-[var(--text-primary)]" data-testid="nc-scope-revoke-yes">
                            {t('nc_scope.revoke_yes', 'Yes, revoke')}
                        </button>
                        <button type="button" onClick={() => setConfirmRevoke(false)} className="text-[var(--text-muted)]">
                            {t('nc_scope.revoke_no', 'Keep')}
                        </button>
                    </span>
                ) : (
                    <button
                        type="button"
                        onClick={() => setConfirmRevoke(true)}
                        disabled={allOff}
                        className="text-[12px] font-medium disabled:opacity-40 text-[var(--text-primary)]"
                        data-testid="nc-scope-revoke"
                    >
                        {t('nc_scope.revoke', 'Revoke all Nextcloud access')}
                    </button>
                )}
            </div>
        </div>
    );
};

export default NcScopeSection;
