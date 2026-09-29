/**
 * Organisation setting — may integration answers be kept BETWEEN runs?
 *
 * The separation this screen has to make legible: a routine can already reuse
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

import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';
import ChoiceCards from '../../shared/ChoiceCards';
import { toast } from '../../shared/Toast';

const MINUTES = (s) => Math.round(s / 60);

// An admin deciding whether to clear needs a size, not just a count — a
// thousand calendar look-ups and a thousand mail searches are not the same
// amount of somebody's data sitting in the database.
const BYTES = (n) => {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} kB`;
    return `${n} B`;
};

export default function OrgIntegrationCacheEditor({ orgId }) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [server, setServer] = useState(null);
    const [enabled, setEnabled] = useState(false);
    const [ttlSeconds, setTtlSeconds] = useState(300);
    // WHICH outbound answers the consent covers. One decision, one config row,
    // two ticks — because an admin who said yes to "what a connected app
    // answers" did not thereby say yes to arbitrary outbound web-service calls
    // a routine author writes by hand.
    const [scopeIntegration, setScopeIntegration] = useState(true);
    const [scopeHttp, setScopeHttp] = useState(false);
    const [saving, setSaving] = useState(false);
    const [clearing, setClearing] = useState(false);

    const load = useCallback(async () => {
        if (!orgId) return;
        setLoading(true);
        setLoadError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/org-integration-cache/${orgId}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setServer(data);
            setEnabled(!!data.enabled);
            setTtlSeconds(data.ttlSeconds ?? 300);
            setScopeIntegration(data.scopes ? data.scopes.integration !== false : true);
            setScopeHttp(!!(data.scopes && data.scopes.http));
        } catch (err) {
            // Null the loaded state so Save stays disabled — saving on top of a
            // failed load would write a guess about somebody's data policy.
            setServer(null);
            setLoadError(err.message);
        } finally {
            setLoading(false);
        }
    }, [orgId]);

    useEffect(() => { load(); }, [load]);

    const serverScopes = server?.scopes || { integration: true, http: false };
    const isDirty = !!server && (
        enabled !== !!server.enabled
        || ttlSeconds !== server.ttlSeconds
        || scopeIntegration !== (serverScopes.integration !== false)
        || scopeHttp !== !!serverScopes.http
    );

    const handleSave = useCallback(async () => {
        if (!server || !isDirty) return;
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/api/org-integration-cache/${orgId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled, ttlSeconds,
                    scopes: { integration: scopeIntegration, http: scopeHttp },
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(body.error || t('admin.integration_cache.save_failed', 'Could not save the setting'));
                return;
            }
            toast.success(body.purged
                ? t('admin.integration_cache.saved_purged', 'Saved. Stored answers were deleted.')
                : t('admin.integration_cache.saved', 'Saved'));
            await load();
        } catch (err) {
            toast.error(err.message || t('admin.integration_cache.save_failed', 'Could not save the setting'));
        } finally {
            setSaving(false);
        }
    }, [server, isDirty, orgId, enabled, ttlSeconds, scopeIntegration, scopeHttp, t, load]);

    const handleClear = useCallback(async () => {
        setClearing(true);
        try {
            const res = await authFetch(`${API_BASE}/api/org-integration-cache/${orgId}/entries`, { method: 'DELETE' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(body.error || t('admin.integration_cache.clear_failed', 'Could not clear the stored answers'));
                return;
            }
            toast.success(t('admin.integration_cache.cleared', 'Stored answers deleted'));
            await load();
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
                'Nothing an app answers is stored. A routine can still avoid asking the same thing twice inside one run — that reuse never leaves the run.',
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
            <header>
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <DatabaseZap className="h-5 w-5" aria-hidden="true" />
                    {t('admin.integration_cache.title', 'Reusing answers between runs')}
                </h2>
                <p className="mt-1 text-sm opacity-75">
                    {t(
                        'admin.integration_cache.intro',
                        'Routines often ask the same question over and over — of a connected app, or of a web service they call directly. This decides whether the answer may be stored so a later run can use it, which means storing what the other side sent back.',
                    )}
                </p>
            </header>

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
                onChange={(v) => setEnabled(v === 'on')}
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
                            'These are two different promises. The first is about apps this organisation connected and whose permissions it manages. The second is about any web address a routine author types in, so it is off until you say otherwise.',
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
                                {t('admin.integration_cache.scope_integration_desc', 'Look-ups a routine makes through an app action — a calendar, a mailbox, a ticket system.')}
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
                                {t('admin.integration_cache.scope_http_desc', 'Replies to a "Call a web service" step, which can point at any address the routine author chooses. Only ever GET and HEAD, and never when that step is allowed to reach private addresses.')}
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

            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!isDirty || saving}
                    className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary,#0284c7)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
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
            </div>
        </div>
    );
}
