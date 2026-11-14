import React, { useEffect, useEffectEvent, useState } from 'react';
import {
    AppWindow, AlertTriangle, CheckCircle2, HelpCircle, Loader2, Lock,
    Plug, Plus, RefreshCw, Trash2, Workflow, X,
} from 'lucide-react';
import useAutomationApi from '../../hooks/useAutomationApi';
import useTranslation, { TranslateParams } from '../../hooks/useTranslation';
import { RefusedError, errorBody } from '../../api/mutate';
import { apiRequest } from '../../api/typedRequest';
import type { CatalogApp } from '../../components/automation/Builder/flow/stepPalette.types';
import type { AutomationOption, Grants, AutomationApi, StatusPillProps, AddAutomationFormProps, WebpageAppsPanelProps } from './WebpageAppsPanel.types';
import { ConnectLink, AddAppForm } from './AddAppForm';
import { useReloadWebpageAppsPane, useRevokeWebpageGrant, useWebpageGrantsQuery, useWebpagePaneList } from '../../api/queries/webpageGrants';

// How long a catalog/grants snapshot may be shown stale; a window-focus or a
// manual refresh re-fetches (the author may have just connected an app).
const FOCUS_REFETCH_MS = 5_000;

function StatusPill({ available }: StatusPillProps) {
    const { t } = useTranslation();
    if (available === true) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] [color:#10b981]!">
                <CheckCircle2 size={11} /> {t('webpages.apps.status_connected', 'Connected')}
            </span>
        );
    }
    if (available === false) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] [color:#d97706]!">
                <AlertTriangle size={11} /> {t('webpages.apps.status_reconnect', 'Needs reconnect')}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-[10px] text-[var(--vsc-fg-muted)]">
            <HelpCircle size={11} /> {t('webpages.apps.status_unknown', 'Status unknown')}
        </span>
    );
}

// ─── Add-an-app form ────────────────────────────────────────────────

// ─── Add-a-automation form ─────────────────────────────────────────────

function AddAutomationForm({ webpageId, automations, onGranted, onError }: AddAutomationFormProps) {
    const { t } = useTranslation();
    const [automationId, setAutomationId] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        setSubmitting(true);
        try {
            try {
                await apiRequest('POST /api/webpages/{id}/grants/automations', {
                    params: { id: String(webpageId) },
                    init: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ automationId }) },
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                onError(errorBody(err)?.error || t('webpages.apps.err_add_automation', 'Could not add the automation ({status})', { status: err.status }));
                return;
            }
            setAutomationId('');
            onGranted();
        } catch (e) {
            onError((e as Error).message || t('webpages.apps.err_network', 'Could not reach the server.'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 flex-1">
                <span className="text-[11px] text-[var(--vsc-fg-muted)]">{t('webpages.apps.field_automation', 'Automation')}</span>
                <select
                    className="w-full px-2 py-1.5 rounded text-[12px] border outline-none [background:var(--vsc-editor-bg)] [border-color:var(--vsc-border)] [color:var(--vsc-fg)]!"
                    value={automationId}
                    aria-label={t('webpages.apps.field_automation', 'Automation')}
                    onChange={(e) => setAutomationId(e.target.value)}
                >
                    <option value="">{t('webpages.apps.choose_automation', 'Choose an automation…')}</option>
                    {automations.map(a => (
                        <option key={a.automationId || a.id} value={a.automationId || a.id}>
                            {a.title || a.automationId || a.id}
                        </option>
                    ))}
                </select>
            </label>
            <button
                type="button"
                onClick={submit}
                disabled={!automationId || submitting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium text-white disabled:opacity-50 bg-[var(--vsc-accent)]"
            >
                {submitting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                {t('common.add', 'Add')}
            </button>
        </div>
    );
}

// ─── The panel ──────────────────────────────────────────────────────

/** The sentence for a grants read or a revoke that failed: the server's own text, else ours with the status. */
function failureText(err: Error, refused: (status: number) => string): string {
    if (err instanceof RefusedError) return errorBody(err)?.error || refused(err.status);
    return err.message;
}

/** The pane's three reads, as the lists and states it renders. */
function usePaneReads(webpageId: string, active: boolean) {
    const { t } = useTranslation();
    const api: AutomationApi = useAutomationApi();
    const grantsQuery = useWebpageGrantsQuery<Grants>(webpageId, active);
    // Catalog + automations are best-effort: grants stay manageable without them.
    const catalogQuery = useWebpagePaneList(webpageId, 'catalog', () => api.getCatalog<{ apps: CatalogApp[] }>(), active);
    const automationsQuery = useWebpagePaneList(webpageId, 'automations', () => api.listAutomations<{ automations?: AutomationOption[] }>(), active);
    // A failed read of a best-effort list shows as no list, also when an earlier read had one.
    const catalogFailed = catalogQuery.isError;
    return {
        grants: grantsQuery.data ?? null,
        catalogFailed,
        catalog: catalogFailed ? null : catalogQuery.data ?? null,
        automations: automationsQuery.isError ? [] : automationsQuery.data?.automations || [],
        loading: grantsQuery.isPending || catalogQuery.isPending || automationsQuery.isPending,
        loadError: grantsQuery.error && !grantsQuery.isFetching
            ? failureText(grantsQuery.error, status => t('webpages.apps.err_load', 'Could not load apps ({status})', { status }))
            : null,
    };
}

export default function WebpageAppsPanel({ webpageId, readOnly = false }: WebpageAppsPanelProps) {
    const { t } = useTranslation();
    const active = !!webpageId && !readOnly;
    const { grants, catalog, catalogFailed, automations, loading, loadError } = usePaneReads(webpageId, active);
    const reloadPane = useReloadWebpageAppsPane(webpageId);
    const revokeGrant = useRevokeWebpageGrant(webpageId);
    // What an add or a remove reported; the next load clears it.
    const [actionError, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState<string | null>(null); // null | 'app' | 'automation'
    const lastFetchRef = React.useRef(0);
    useEffect(() => { lastFetchRef.current = Date.now(); }, [webpageId, readOnly]);

    const load = async () => {
        if (!active) return;
        lastFetchRef.current = Date.now();
        setError(null);
        await reloadPane();
    };

    // Refetch when the window regains focus (e.g. back from Settings →
    // Integrations), but not more often than FOCUS_REFETCH_MS.
    const onFocus = useEffectEvent(() => {
        if (Date.now() - lastFetchRef.current > FOCUS_REFETCH_MS) void load();
    });
    useEffect(() => {
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, []);

    const revoke = (kind: 'integrations' | 'automations', key: string) => {
        setError(null);
        revokeGrant.mutate({ kind, key }, {
            onSuccess: () => { lastFetchRef.current = Date.now(); },
            onError: (err) => setError(failureText(err, status => t('webpages.apps.err_remove', 'Could not remove ({status})', { status }))),
        });
    };
    const error = actionError ?? loadError;

    if (readOnly) {
        return (
            <div className="p-3 text-[12px] text-[var(--vsc-fg-muted)]">
                {t('webpages.apps.owner_only', 'Only the page owner can manage the apps and automations this page may use.')}
            </div>
        );
    }

    const grantedIntegrations = grants?.integrations || [];
    const grantedAutomations = grants?.automations || [];

    return (
        <div className="flex flex-col h-full overflow-y-auto p-2 gap-3 text-[12px] text-[var(--vsc-fg)]">
            <WebpageAppsPanelSection t={t} load={load} />

            <p className="text-[11px] -mt-1 text-[var(--vsc-fg-muted)]">
                {t('webpages.apps.subtitle', 'What this page may call, running as you. Visitors never need their own accounts.')}
            </p>

            {error ? (
                <p role="alert" className="flex items-start gap-1.5 text-[11px] [color:#ef4444]!">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                </p>
            ) : null}

            {grants?.discoveryFailed ? (
                <p className="flex items-start gap-1.5 text-[11px] [color:#d97706]!">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{t('webpages.apps.discovery_failed', "Couldn't verify your connected apps — statuses below may be stale.")}</span>
                </p>
            ) : null}

            {loading ? (
                <p className="inline-flex items-center gap-1.5 text-[11px] text-[var(--vsc-fg-muted)]">
                    <Loader2 size={12} className="animate-spin" /> {t('webpages.sources.loading', 'Loading…')}
                </p>
            ) : (
                <>
                    {/* Granted integrations */}
                    <section className="flex flex-col gap-1">
                        <span className="text-[11px] font-medium text-[var(--vsc-fg-muted)]">{t('webpages.apps.section_apps', 'Apps')}</span>
                        {grantedIntegrations.length === 0 ? (
                            // `grants` stays null if the read failed, and then this list is empty without
                            // anything having been counted. "No apps yet" is a claim: the author
                            // would not see five granted connections and therefore could not revoke
                            // them either.
                            <p className="text-[11px]" style={{ color: grants ? 'var(--vsc-fg-muted)' : '#d97706' }} data-testid="apps-empty">
                                {grants
                                    ? t('webpages.apps.none_yet', 'No apps yet. Add one so the page can read or act in tools you already use.')
                                    : t('webpages.apps.grants_unreadable', 'The apps on this page could not be read, so this is not “no apps”. Try again before you add one.')}
                            </p>
                        ) : grantedIntegrations.map(g => (
                            <div
                                key={g.tool}
                                className="group flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--vsc-border)] bg-[var(--vsc-editor-bg)]"
                            >
                                <Plug size={13} className="shrink-0 [color:var(--vsc-fg-muted)]" />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate" title={g.tool}>
                                        {g.label || (g.tool || '').replace(/_/g, ' ')}
                                        {g.integrationLabel ? (
                                            <span className="text-[var(--vsc-fg-muted)]"> · {g.integrationLabel}</span>
                                        ) : null}
                                        {g.hasFixedArgs ? (
                                            <Lock size={10} className="inline ml-1 -mt-0.5" aria-label={t('webpages.apps.has_pinned', 'Has pinned arguments')} />
                                        ) : null}
                                    </div>
                                    <StatusPill available={g.available} />
                                </div>
                                {g.available === false ? (
                                    <ConnectLink webpageId={webpageId}>{t('webpages.apps.reconnect', 'Reconnect')}</ConnectLink>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() => revoke('integrations', g.tool)}
                                    aria-label={t('webpages.build.remove_source', 'Remove {name}', { name: g.tool })}
                                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--vsc-hover-bg)] [color:#ef4444]"
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))}
                        {adding === 'app' ? (
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() => setAdding(null)}
                                    aria-label={t('common.close', 'Close')}
                                    className="absolute right-1 top-1 p-1 rounded hover:bg-[var(--vsc-hover-bg)] text-[var(--vsc-fg-muted)]"
                                >
                                    <X size={12} />
                                </button>
                                <AddAppForm
                                    webpageId={webpageId}
                                    catalog={catalog}
                                    onGranted={() => { setAdding(null); load(); }}
                                    onError={setError}
                                />
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setAdding('app')}
                                disabled={catalogFailed && !catalog}
                                title={catalogFailed ? t('webpages.apps.catalog_failed_title', 'The app catalog could not be loaded') : undefined}
                                className="self-start inline-flex items-center gap-1.5 px-2 py-1.5 rounded border border-dashed text-[11px] disabled:opacity-50 border-[var(--vsc-border)] text-[var(--vsc-fg-muted)]"
                            >
                                <AppWindow size={12} /> {t('webpages.apps.add_app', 'Add an app')}
                            </button>
                        )}
                        {catalogFailed ? (
                            <p className="text-[10px] text-[var(--vsc-fg-muted)]">
                                {t('webpages.apps.catalog_failed', "Your app catalog couldn't be loaded (automations may be off for your plan). Refresh to try again.")}
                            </p>
                        ) : null}
                    </section>

                    {/* Granted automations */}
                    <section className="flex flex-col gap-1">
                        <span className="text-[11px] font-medium text-[var(--vsc-fg-muted)]">{t('webpages.apps.section_automations', 'Automations')}</span>
                        {grantedAutomations.length === 0 ? (
                            <p className="text-[11px]" style={{ color: grants ? 'var(--vsc-fg-muted)' : '#d97706' }} data-testid="automations-empty">
                                {grants
                                    ? t('webpages.apps.no_automations', 'No automations yet. Let the page trigger one of your automations and use its result.')
                                    : t('webpages.apps.grants_unreadable', 'The apps on this page could not be read, so this is not “no apps”. Try again before you add one.')}
                            </p>
                        ) : grantedAutomations.map(g => (
                            <div
                                key={g.automationId}
                                className="group flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--vsc-border)] bg-[var(--vsc-editor-bg)]"
                            >
                                <Workflow size={13} className="shrink-0 [color:var(--vsc-fg-muted)]" />
                                <span className="min-w-0 flex-1 truncate" title={g.automationId}>
                                    {g.label || g.automationId}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => revoke('automations', g.automationId)}
                                    aria-label={t('webpages.build.remove_source', 'Remove {name}', { name: g.label || g.automationId })}
                                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--vsc-hover-bg)] [color:#ef4444]"
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))}
                        {adding === 'automation' ? (
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() => setAdding(null)}
                                    aria-label={t('common.close', 'Close')}
                                    className="absolute right-1 -top-1 p-1 rounded hover:bg-[var(--vsc-hover-bg)] z-10 text-[var(--vsc-fg-muted)]"
                                >
                                    <X size={12} />
                                </button>
                                <AddAutomationForm
                                    webpageId={webpageId}
                                    automations={automations}
                                    onGranted={() => { setAdding(null); load(); }}
                                    onError={setError}
                                />
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setAdding('automation')}
                                className="self-start inline-flex items-center gap-1.5 px-2 py-1.5 rounded border border-dashed text-[11px] border-[var(--vsc-border)] text-[var(--vsc-fg-muted)]"
                            >
                                <Workflow size={12} /> {t('webpages.apps.add_automation', 'Add an automation')}
                            </button>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}

function WebpageAppsPanelSection({ t, load }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; load: () => Promise<void>; }) {
    return <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--vsc-fg-muted)]">
            {t('webpages.apps.title', 'Apps & data')}
        </span>
        <button
            type="button"
            onClick={load}
            title={t('webpages.refresh', 'Refresh')}
            aria-label={t('webpages.apps.refresh_aria', 'Refresh apps and grants')}
            className="p-1 rounded hover:bg-[var(--vsc-hover-bg)] text-[var(--vsc-fg-muted)]"
        >
            <RefreshCw size={13} />
        </button>
    </div>;
}
