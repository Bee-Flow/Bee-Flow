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
 * rows behind would not be what anyone read it as. Deleting what is stored now
 * asks first.
 *
 * The page title is the dashboard frame's (AdminPage); the panel opens with its
 * own sub-heading so it also reads where it is stacked under other panels.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useOrgSettingRead } from './useOrgSettingRead';
import OrgEditorLoad from './OrgEditorLoad';

import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { KeptSettings, KillSwitchNotice, StoredAnswers, cacheModeOptions, type CacheScopes } from './OrgIntegrationCacheParts';
import { messageOf } from '@/utils/caughtError';
import ChoiceCards from '@/components/shared/ChoiceCards';
import SaveFooter from '@/components/shared/SaveFooter';
import { SettingsGroup } from '@/components/shared/SettingsList';
import { toast } from '@/components/shared/Toast';
import useConfirm from '@/components/shared/useConfirm';
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

/**
 * WHICH outbound answers the consent covers, as the server holds them. One
 * decision, one config row, three ticks — because an admin who said yes to
 * "what a connected app answers" did not thereby say yes to arbitrary outbound
 * web-service calls, nor to keeping what an AI model wrote about somebody's
 * data. A server that predates scopes reads as app look-ups on, the rest off.
 */
function scopesOf(server: IntegrationCacheSettings | null): CacheScopes {
    const s = server?.scopes;
    return { integration: s ? s.integration !== false : true, http: !!s?.http, ai: !!s?.ai };
}

function sameScopes(a: CacheScopes, b: CacheScopes): boolean {
    return a.integration === b.integration && a.http === b.http && a.ai === b.ai;
}

/** What is stored now: live rows plus expired ones the hourly prune has not reached yet. */
function storedOf(server: IntegrationCacheSettings) {
    const expiredEntries = server.expiredEntries ?? 0;
    return { storedEntries: (server.entries ?? 0) + expiredEntries, expiredEntries, storedBytes: server.bytes ?? 0 };
}

/** The loaded setting, the choices seeded from it, the save and the clear. */
function useIntegrationCacheForm(orgId: string | null | undefined, t: TranslateFn) {
    const [enabled, setEnabled] = useState(false);
    const [ttlSeconds, setTtlSeconds] = useState(300);
    const [scopes, setScopes] = useState<CacheScopes>(() => scopesOf(null));
    const [savedAt, setSavedAt] = useState<Date | null>(null);

    // A failed load leaves `server` null, so Save stays disabled — saving on top
    // of a failed load would write a guess about somebody's data policy.
    const { server, loading, loadError, refetch } = useOrgSettingRead<IntegrationCacheSettings>('GET /api/org-integration-cache/{orgId}', orgId);
    const [seeded, setSeeded] = useState<IntegrationCacheSettings | null>(null);
    if (server && server !== seeded) {
        setSeeded(server);
        setEnabled(!!server.enabled);
        setTtlSeconds(server.ttlSeconds ?? 300);
        setScopes(scopesOf(server));
    }

    const isDirty = !!server && (
        enabled !== !!server.enabled || ttlSeconds !== server.ttlSeconds || !sameScopes(scopes, scopesOf(server))
    );

    const save = useMutation({
        mutationFn: () => writeOutcome(() => apiRequest('PUT /api/org-integration-cache/{orgId}', {
            params: { orgId: String(orgId) },
            body: { enabled, ttlSeconds, scopes },
        })),
        onSuccess: async ({ refused, body }) => {
            if (refused !== null) { toast.error(refused || t('admin.integration_cache.save_failed', 'Could not save the setting')); return; }
            setSavedAt(new Date());
            if (body.purged) toast.success(t('admin.integration_cache.saved_purged', 'Saved. Stored answers were deleted.'));
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

    const reset = () => {
        if (!server) return;
        setEnabled(!!server.enabled);
        setTtlSeconds(server.ttlSeconds ?? 300);
        setScopes(scopesOf(server));
    };

    return {
        server, loading, loadError, refetch, enabled, setEnabled, ttlSeconds, setTtlSeconds,
        scopes, setScope: (patch: Partial<CacheScopes>) => setScopes((s) => ({ ...s, ...patch })),
        isDirty, reset, savedAt, saving: save.isPending, saveFailed: save.isError, clearing: clear.isPending,
        // The toasts are the mutations' own; the section only awaits the outcome.
        handleSave: () => { if (server && isDirty) save.mutateAsync().catch(() => undefined); },
        handleClear: async () => { await clear.mutateAsync().catch(() => undefined); },
    };
}

type CacheForm = ReturnType<typeof useIntegrationCacheForm>;

function CacheFormBody({ form, server, t }: { form: CacheForm; server: IntegrationCacheSettings; t: TranslateFn }) {
    const { confirm, confirmDialog } = useConfirm();
    const { storedEntries, storedBytes, expiredEntries } = storedOf(server);

    const askClear = async () => {
        const ok = await confirm({
            title: t('admin_org_ai.cache_clear_title', 'Delete the stored answers?'),
            description: t('admin_org_ai.cache_clear_desc', 'Every answer this organisation has stored is deleted now. Later runs ask the app, service or model again, so nothing else is lost.'),
            confirmLabel: t('admin_org_ai.cache_clear_confirm', 'Delete answers'),
            destructive: true,
        });
        if (ok) await form.handleClear();
    };

    return (
        <>
            <SettingsGroup
                title={t('admin.integration_cache.title', 'Reusing answers between runs')}
                description={t(
                    'admin_org_ai.cache_intro',
                    'Automations often ask the same question over and over: of a connected app, of a web service they call directly, or of an AI model in an AI step. This decides whether the answer may be stored so a later run can use it, which means storing what the other side sent back.',
                )}
            >
                {server.killSwitch && <KillSwitchNotice t={t} />}
                <ChoiceCards
                    value={form.enabled ? 'on' : 'off'}
                    onChange={(v: string) => form.setEnabled(v === 'on')}
                    options={cacheModeOptions(t)}
                    columns={1}
                    ariaLabel={t('admin.integration_cache.choose', 'Reusing answers between runs')}
                    disabled={form.saving}
                />
            </SettingsGroup>

            {form.enabled && (
                <KeptSettings t={t} saving={form.saving} scopes={form.scopes} setScope={form.setScope}
                    range={server.ttlRange || { min: 60, max: 3600 }} ttlSeconds={form.ttlSeconds} setTtlSeconds={form.setTtlSeconds} />
            )}

            <SaveFooter
                onSave={form.handleSave}
                onCancel={form.isDirty && !form.saving ? form.reset : undefined}
                saving={form.saving}
                dirty={form.isDirty}
                saveState={form.saving ? 'saving' : form.saveFailed ? 'error' : 'idle'}
                lastSavedAt={form.savedAt}
                onRetry={form.handleSave}
            />

            {/* Expired rows are deleted by an HOURLY prune, so between passes they
                are still rows in the database: they count, and the clear is
                offered on that same number, because it deletes everything. */}
            {storedEntries > 0 && (
                <StoredAnswers t={t} storedEntries={storedEntries} storedBytes={storedBytes} expiredEntries={expiredEntries}
                    clearing={form.clearing} onClear={() => { void askClear(); }} />
            )}
            {confirmDialog}
        </>
    );
}

export default function OrgIntegrationCacheEditor({ orgId }: { orgId?: string | null }) {
    const { t } = useTranslation();
    const form = useIntegrationCacheForm(orgId, t);

    if (!orgId) return null;

    const loadError = form.loadError ? `${t('admin.integration_cache.load_failed', 'Could not load this setting.')} ${form.loadError}` : null;
    return (
        <div className="space-y-6" data-testid="org-integration-cache">
            <OrgEditorLoad loading={form.loading && !form.server} error={loadError} onRetry={() => { void form.refetch(); }}>
                {form.server && <CacheFormBody form={form} server={form.server} t={t} />}
            </OrgEditorLoad>
        </div>
    );
}
