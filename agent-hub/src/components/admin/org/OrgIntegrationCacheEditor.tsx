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
import React, { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '@/hooks/useTranslation';
import {
    KillSwitchNotice, OrgIntegrationCacheEditorHeader, OrgIntegrationCacheEditorSection, ScopeChecks, StoredLine, TtlPicker, cacheModeOptions,
} from './OrgIntegrationCacheParts';
import { API_BASE } from '@/utils/helpers';
import { errorMessage, messageOf } from '@/utils/caughtError';
import ChoiceCards from '../../shared/ChoiceCards';
import { toast } from '../../shared/Toast';
import { request, errorBody, RefusedError, mutate } from '@/api/mutate';

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

export default function OrgIntegrationCacheEditor({ orgId }: { orgId?: string | null }) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null | undefined>(null);
    const [server, setServer] = useState<IntegrationCacheSettings | null>(null);
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
    const [saving, setSaving] = useState(false);
    const [clearing, setClearing] = useState(false);

    const load = useCallback(async () => {
        if (!orgId) return;
        setLoading(true);
        setLoadError(null);
        try {
            let res: Response;
            try {
                res = await request(`${API_BASE}/api/org-integration-cache/${orgId}`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                throw new Error(body.error || `HTTP ${err.status}`);
            }
            const data = await res.json();
            setServer(data);
            setEnabled(!!data.enabled);
            setTtlSeconds(data.ttlSeconds ?? 300);
            setScopeIntegration(data.scopes ? data.scopes.integration !== false : true);
            setScopeHttp(!!(data.scopes && data.scopes.http));
            setScopeAi(!!(data.scopes && data.scopes.ai));
        } catch (err) {
            // Null the loaded state so Save stays disabled — saving on top of a
            // failed load would write a guess about somebody's data policy.
            setServer(null);
            setLoadError(errorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [orgId]);

    useEffect(() => { load(); }, [load]);

    const serverScopes = server?.scopes || { integration: true, http: false, ai: false };
    const isDirty = !!server && (
        enabled !== !!server.enabled
        || ttlSeconds !== server.ttlSeconds
        || scopeIntegration !== (serverScopes.integration !== false)
        || scopeHttp !== !!serverScopes.http
        || scopeAi !== !!serverScopes.ai
    );

    const handleSave = useCallback(async () => {
        if (!server || !isDirty) return;
        setSaving(true);
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/org-integration-cache/${orgId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled, ttlSeconds,
                    scopes: { integration: scopeIntegration, http: scopeHttp, ai: scopeAi },
                }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                toast.error(body.error || t('admin.integration_cache.save_failed', 'Could not save the setting'));
                return;
            }
            const body = await res.json().catch(() => ({}));
            toast.success(body.purged
                ? t('admin.integration_cache.saved_purged', 'Saved. Stored answers were deleted.')
                : t('admin.integration_cache.saved', 'Saved'));
            await load();
        } catch (err) {
            toast.error(messageOf(err, t('admin.integration_cache.save_failed', 'Could not save the setting')));
        } finally {
            setSaving(false);
        }
    }, [server, isDirty, orgId, enabled, ttlSeconds, scopeIntegration, scopeHttp, scopeAi, t, load]);

    const handleClear = useCallback(async () => {
        setClearing(true);
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/org-integration-cache/${orgId}/entries`, { method: 'DELETE' });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                toast.error(body.error || t('admin.integration_cache.clear_failed', 'Could not clear the stored answers'));
                return;
            }
            const body = await res.json().catch(() => ({}));
            toast.success(t('admin.integration_cache.cleared', 'Stored answers deleted'));
            await load();
        } catch {
            // A dropped request must not look like nothing happened: the
            // answers are still stored, and the admin has to know that.
            toast.error(t('admin.integration_cache.clear_failed', 'Could not clear the stored answers'));
        } finally {
            setClearing(false);
        }
    }, [orgId, t, load]);

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
