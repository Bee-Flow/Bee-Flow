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
import { AlertTriangle, DatabaseZap, Loader2, Timer, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { TranslateParams, useTranslation } from '../../../hooks/useTranslation';
import { API_BASE } from '../../../utils/helpers';
import { errorMessage, messageOf } from '../../../utils/caughtError';
import ChoiceCards from '../../shared/ChoiceCards';
import { toast } from '../../shared/Toast';
import { request, errorBody, RefusedError, mutate } from '../../../api/mutate';

const MINUTES = (s: number) => Math.round(s / 60);

// An admin deciding whether to clear needs a size, not just a count — a
// thousand calendar look-ups and a thousand mail searches are not the same
// amount of somebody's data sitting in the database.
const BYTES = (n: number) => {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} kB`;
    return `${n} B`;
};

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

    const options = [
        {
            value: 'off',
            label: t('admin.integration_cache.off', 'Ask every run (recommended)'),
            description: t(
                'admin.integration_cache.off_desc',
                'Nothing an app answers is stored. An automation can still avoid asking the same thing twice inside one run — that reuse never leaves the run.',
            ),
            Icon: DatabaseZap,
        },
        {
            value: 'on',
            label: t('admin.integration_cache.on', 'Keep answers for a short while'),
            description: t(
                'admin.integration_cache.on_desc',
                'Answers are stored, encrypted, so a later run can use them instead of asking again — both what a connected app answers and what a web service call brings back. Only look-ups, never anything that changes something, and only for steps whose author asked for it. Faster and cheaper — but a run can then work from data that is a few minutes old.',
            ),
            Icon: Timer,
        },
    ];

    return (
        <div className="space-y-5 p-1">
            <OrgIntegrationCacheEditorHeader t={t} />

            {server?.killSwitch && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                    {t(
                        'admin.integration_cache.kill_switch',
                        'This is switched off for the whole server by its operator, so nothing is stored whatever you choose here.',
                    )}
                </div>
            )}

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
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={scopeIntegration}
                            disabled={saving}
                            onChange={(e) => setScopeIntegration(e.target.checked)}
                        />
                        <span>
                            {t('admin.integration_cache.scope_integration', 'Answers from connected apps')}
                            <span className="block text-xs opacity-70">
                                {t('admin.integration_cache.scope_integration_desc', 'Look-ups an automation makes through an app action — a calendar, a mailbox, a ticket system.')}
                            </span>
                        </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={scopeHttp}
                            disabled={saving}
                            onChange={(e) => setScopeHttp(e.target.checked)}
                        />
                        <span>
                            {t('admin.integration_cache.scope_http', 'Answers from web service calls')}
                            <span className="block text-xs opacity-70">
                                {t('admin.integration_cache.scope_http_desc', 'Replies to a "Call a web service" step, which can point at any address the automation author chooses. Only ever GET and HEAD, and never when that step is allowed to reach private addresses.')}
                            </span>
                        </span>
                    </label>

                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={scopeAi}
                            disabled={saving}
                            onChange={(e) => setScopeAi(e.target.checked)}
                        />
                        <span>
                            {t('admin.integration_cache.scope_ai', 'Answers from AI steps')}
                            <span className="block text-xs opacity-70">
                                {t('admin.integration_cache.scope_ai_desc', 'When an AI step asks the same question with the same (privacy-protected) input, the stored answer is reused instead of asking the model again. Stored encrypted until the window ends; never used in test runs.')}
                            </span>
                        </span>
                    </label>

                    <label htmlFor="integration-cache-ttl" className="block text-sm font-medium pt-2">
                        {t('admin.integration_cache.ttl_label', 'How long an answer may be reused')}
                    </label>
                    <p className="text-xs opacity-70">
                        {t(
                            'admin.integration_cache.ttl_note',
                            'After this, the answer is deleted and the next run asks the app again. This is also the longest a run can be working from stale data. Shortening it applies to answers already stored, not just new ones.',
                        )}
                    </p>
                    <div className="flex items-center gap-3">
                        <input
                            id="integration-cache-ttl"
                            type="range"
                            min={range.min}
                            max={range.max}
                            step={60}
                            value={ttlSeconds}
                            onChange={(e) => setTtlSeconds(Number(e.target.value))}
                            disabled={saving}
                            className="flex-1"
                        />
                        <span className="w-28 shrink-0 text-sm tabular-nums">
                            {t('admin.integration_cache.ttl_minutes', '{{n}} minutes').replace('{{n}}', String(MINUTES(ttlSeconds)))}
                        </span>
                    </div>
                </div>
            )}

            {storedEntries > 0 && (
                <p className="text-xs opacity-70">
                    {t('admin.integration_cache.held', 'Stored right now: {{n}} answer(s), {{size}}.')
                        .replace('{{n}}', String(storedEntries))
                        .replace('{{size}}', BYTES(storedBytes))}
                    {expiredEntries > 0 && ' ' + t(
                        'admin.integration_cache.held_expired',
                        '{{n}} of those have already expired and are never served — they are deleted by the hourly clean-up, or by the button below.',
                    ).replace('{{n}}', String(expiredEntries))}
                </p>
            )}

            <OrgIntegrationCacheEditorSection handleSave={handleSave} isDirty={isDirty} saving={saving} t={t} storedEntries={storedEntries} handleClear={handleClear} clearing={clearing} />
        </div>
    );
}

function OrgIntegrationCacheEditorHeader({ t }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; }) {
    return <header>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
            <DatabaseZap className="h-5 w-5" aria-hidden="true" />
            {t('admin.integration_cache.title', 'Reusing answers between runs')}
        </h2>
        <p className="mt-1 text-sm opacity-75">
            {t(
                'admin.integration_cache.intro',
                'Automations often ask the same question over and over — of a connected app, or of a web service they call directly. This decides whether the answer may be stored so a later run can use it, which means storing what the other side sent back.'
            )}
        </p>
    </header>;
}

function OrgIntegrationCacheEditorSection({ handleSave, isDirty, saving, t, storedEntries, handleClear, clearing }: { handleSave: () => Promise<void>; isDirty: boolean; saving: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; storedEntries: number; handleClear: () => Promise<void>; clearing: boolean; }) {
    return <div className="flex flex-wrap items-center gap-3">
        <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary)] px-3 py-2 text-sm font-medium text-[var(--accent-primary-fg)] disabled:opacity-50"
        >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {t('common.save', 'Save')}
        </button>

        {storedEntries > 0 && (
            <button
                type="button"
                onClick={handleClear}
                disabled={clearing}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm disabled:opacity-50"
            >
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                {t('admin.integration_cache.clear', 'Delete the {{n}} stored answer(s) now').replace('{{n}}', String(storedEntries))}
            </button>
        )}
    </div>;
}
