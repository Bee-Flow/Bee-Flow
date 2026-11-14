/**
 * Organisation setting — may integration answers be kept BETWEEN runs?
 *
 * The separation this screen has to make legible: an automation can already reuse
 * an answer WITHIN one run (the step's own "ask this app only once" tick), and
 * that stores nothing anywhere. This setting is about the other thing —
 * keeping the answer in the database so a LATER run can use it — and that is a
 * processing decision, not a performance tweak. So the copy says what is
 * stored, not just what is saved.
 *
 * Off by default. Turning it off again also forgets what is already stored,
 * and the screen reports how much went, because an "off" that quietly left
 * rows behind would not be what anyone read it as.
 */
import { AlertTriangle, Loader2 } from 'lucide-react';
import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useOrgSettingRead } from './useOrgSettingRead';

import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import {
    KillSwitchNotice, OrgIntegrationCacheEditorHeader, OrgIntegrationCacheEditorSection, ScopeChecks, StoredLine, TtlPicker, cacheModeOptions,
} from './OrgIntegrationCacheParts';
import { messageOf } from '@/utils/caughtError';
import ChoiceCards from '../../shared/ChoiceCards';
import { toast } from '../../shared/Toast';
import { errorBody, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

/** GET /api/org-integration-cache/:orgId (the fields this editor reads). */
interface IntegrationCacheSettings {
    enabled?: boolean;
    ttlSeconds?: number;
    scopes?: { integration?: boolean; http?: boolean; ai?: boolean };
    entries?: number;
    expiredEntries?: number;
    bytes?: number;
    killSwitch?: boolean;
    ttlRange?: { min: number; max: number };
}

/** A write's outcome: the parsed body, or the server's refusal text. */
type WriteOutcome = { refused: string | null; body: { purged?: boolean } };

async function writeOutcome(send: () => Promise<Response>): Promise<WriteOutcome> {
    try {
        const res = await send();
        return { refused: null, body: await res.json().catch(() => ({})) };
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        return { refused: (errorBody(err) ?? {}).error || '', body: {} };
    }
}

/** The loaded setting, the choices seeded from it, the save and the clear. */
function useIntegrationCacheForm(orgId: string | null | undefined, t: TranslateFn) {
    const [enabled, setEnabled] = useState(false);
    const [ttlSeconds, setTtlSeconds] = useState(300);
    // WHICH outbound answers the consent covers. One decision, one config row,
    // two ticks — because an admin who said yes to "what a connected app
    // answers" did not thereby say yes to arbitrary outbound web-service calls
    // an automation author writes by hand.
    const [scopeIntegration, setScopeIntegration] = useState(true);
    const [scopeHttp, setScopeHttp] = useState(false);
    // What an AI step answered. Off until said otherwise: a stored answer is a
    // copy of what the model wrote about somebody's data.
    const [scopeAi, setScopeAi] = useState(false);

    // A failed load leaves `server` null, so Save stays disabled — saving on top
    // of a failed load would write a guess about somebody's data policy.
    const { server, loading, loadError, refetch } = useOrgSettingRead<IntegrationCacheSettings>('GET /api/org-integration-cache/{orgId}', orgId);
    const [seeded, setSeeded] = useState<IntegrationCacheSettings | null>(null);
    if (server && server !== seeded) {
        setSeeded(server);
        setEnabled(!!server.enabled);
        setTtlSeconds(server.ttlSeconds ?? 300);
        setScopeIntegration(server.scopes ? server.scopes.integration !== false : true);
        setScopeHttp(!!(server.scopes && server.scopes.http));
        setScopeAi(!!(server.scopes && server.scopes.ai));
    }

    const serverScopes = server?.scopes || { integration: true, http: false, ai: false };
    const isDirty = !!server && (
        enabled !== !!server.enabled
        || ttlSeconds !== server.ttlSeconds
        || scopeIntegration !== (serverScopes.integration !== false)
        || scopeHttp !== !!serverScopes.http
        || scopeAi !== !!serverScopes.ai
    );

    const save = useMutation({
        mutationFn: () => writeOutcome(() => apiRequest('PUT /api/org-integration-cache/{orgId}', {
            params: { orgId: String(orgId) },
            body: { enabled, ttlSeconds, scopes: { integration: scopeIntegration, http: scopeHttp, ai: scopeAi } },
        })),
        onSuccess: async ({ refused, body }) => {
            if (refused !== null) { toast.error(refused || t('admin.integration_cache.save_failed', 'Could not save the setting')); return; }
            toast.success(body.purged
                ? t('admin.integration_cache.saved_purged', 'Saved. Stored answers were deleted.')
                : t('admin.integration_cache.saved', 'Saved'));
            await refetch();
        },
        onError: (err) => toast.error(messageOf(err, t('admin.integration_cache.save_failed', 'Could not save the setting'))),
    });

    const clear = useMutation({
        mutationFn: () => writeOutcome(() => apiRequest('DELETE /api/org-integration-cache/{orgId}/entries', { params: { orgId: String(orgId) } })),
        onSuccess: async ({ refused }) => {
            if (refused !== null) { toast.error(refused || t('admin.integration_cache.clear_failed', 'Could not clear the stored answers')); return; }
            toast.success(t('admin.integration_cache.cleared', 'Stored answers deleted'));
            await refetch();
        },
        // A dropped request must not look like nothing happened: the
        // answers are still stored, and the admin has to know that.
        onError: () => toast.error(t('admin.integration_cache.clear_failed', 'Could not clear the stored answers')),
    });

    return {
        server, loading, loadError, enabled, setEnabled, ttlSeconds, setTtlSeconds,
        scopeIntegration, setScopeIntegration, scopeHttp, setScopeHttp, scopeAi, setScopeAi, isDirty,
        saving: save.isPending, clearing: clear.isPending,
        // The toasts are the mutations' own; the section only awaits the outcome.
        handleSave: async () => { if (server && isDirty) await save.mutateAsync().catch(() => undefined); },
        handleClear: async () => { await clear.mutateAsync().catch(() => undefined); },
    };
}

export default function OrgIntegrationCacheEditor({ orgId }: { orgId?: string | null }) {
    const { t } = useTranslation();
    const { server, loading, loadError, enabled, setEnabled, ttlSeconds, setTtlSeconds, scopeIntegration, setScopeIntegration, scopeHttp, setScopeHttp, scopeAi, setScopeAi, isDirty, saving, clearing, handleSave, handleClear } = useIntegrationCacheForm(orgId, t);

    if (!orgId) return null;

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-4 text-sm opacity-75">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('common.loading', 'Loading...')}
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="p-4">
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                    <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                    {t('admin.integration_cache.load_failed', 'Could not load this setting.')} {loadError}
                </div>
            </div>
        );
    }

    const range = server?.ttlRange || { min: 60, max: 3600 };
    const entries = server?.entries ?? 0;
    // Expired rows are deleted by an HOURLY prune, so between passes they are
    // still rows in the database. Counting only the live ones told an org it
    // held nothing while thousands sat there — and the purge button, which
    // deletes everything, was hidden on exactly that screen.
    const expiredEntries = server?.expiredEntries ?? 0;
    const storedEntries = entries + expiredEntries;
    const storedBytes = server?.bytes ?? 0;

    const options = cacheModeOptions(t);

    return (
        <div className="space-y-5 p-1">
            <OrgIntegrationCacheEditorHeader t={t} />

            {server?.killSwitch && <KillSwitchNotice t={t} />}

            <ChoiceCards
                value={enabled ? 'on' : 'off'}
                onChange={(v: string) => setEnabled(v === 'on')}
                options={options}
                columns={1}
                ariaLabel={t('admin.integration_cache.choose', 'Reusing answers between runs')}
                disabled={saving}
            />

            {enabled && (
                <div className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4">
                    <div className="text-sm font-medium">
                        {t('admin.integration_cache.scopes_label', 'What may be kept')}
                    </div>
                    <p className="text-xs opacity-70">
                        {t(
                            'admin.integration_cache.scopes_note',
                            'These are different promises. The first is about apps this organisation connected and whose permissions it manages. The second is about any web address an automation author types in, and the third about what an AI model wrote, so those two are off until you say otherwise.',
                        )}
                    </p>
                    <ScopeChecks t={t} saving={saving} scopeIntegration={scopeIntegration} setScopeIntegration={setScopeIntegration}
                        scopeHttp={scopeHttp} setScopeHttp={setScopeHttp} scopeAi={scopeAi} setScopeAi={setScopeAi} />

                    <TtlPicker t={t} range={range} ttlSeconds={ttlSeconds} setTtlSeconds={setTtlSeconds} saving={saving} />
                </div>
            )}

            {storedEntries > 0 && <StoredLine t={t} storedEntries={storedEntries} storedBytes={storedBytes} expiredEntries={expiredEntries} />}

            <OrgIntegrationCacheEditorSection handleSave={handleSave} isDirty={isDirty} saving={saving} t={t} storedEntries={storedEntries} handleClear={handleClear} clearing={clearing} />
        </div>
    );
}
