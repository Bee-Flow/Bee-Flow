import { SetStateAction, Dispatch, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { AlertTriangle, FileUp, Loader2, Plug, Search } from 'lucide-react';
import { TranslateParams, useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import { useConnectHub, useDisconnectHub, useMarketplace, useModulesHealth } from '@/api/queries/modules';
import { type MarketplaceModuleDetail } from '@/api/queries/modules.types';
import { HubUnavailable, LoadMore, MarketplaceOverlays, ModuleGrid } from './MarketplaceParts';
import ConnectHubBanner from './ConnectHubBanner';
import ConnectHubDialog from './ConnectHubDialog';
import { useModuleActions, type ModuleApiError } from './moduleActions';
import { parsePurchaseReturn, stripPurchaseReturnParams } from './purchaseReturn';
import { parseModuleDeepLink, searchWithModule, searchWithoutModule } from './moduleDeepLink';

// Marketplace (module hub) tab. Owns the connect/browse/buy/install lifecycle;
// all wire calls go through the modules.ts hooks and the shared useModuleActions
// hook (also driving the detail drawer). Purchases are honest: Buy opens Stripe
// Checkout in a new tab, the card shows "awaiting payment" with an explicit
// "I've paid — refresh" button, and the entitlement flip drives the Install
// button. Terminal install truth always comes from a fresh list fetch.

interface MarketplaceTabProps {
    flash: (msg: { type: string; text: string; }) => void;
    reloadEntitlements: () => void;
}

type ModuleActions = ReturnType<typeof useModuleActions>;

interface PurchaseReturnArgs {
    flash: MarketplaceTabProps['flash'];
    t: TranslateFn;
    refreshEnt: ModuleActions['refreshEnt'];
    setAwaitingIds: ModuleActions['setAwaitingIds'];
    reloadEntitlements: () => void;
    refetch: () => void;
}

function usePurchaseReturn({ flash, t, refreshEnt, setAwaitingIds, reloadEntitlements, refetch }: PurchaseReturnArgs) {
    // ── Stripe Checkout return (?purchase=success|cancel&module=<id>) ──
    // Checkout sends the customer back here (URLs built in moduleActions.buy).
    // Handle once on mount, then strip the params so a reload doesn't replay
    // the flash. Success also marks the module awaiting so the background poll
    // below keeps refreshing until the entitlement lands.
    const handlePurchaseReturn = useEffectEvent(() => {
        const ret = parsePurchaseReturn(window.location.search);
        if (!ret) return;
        window.history.replaceState(null, '', stripPurchaseReturnParams(window.location));
        if (ret.result === 'success') {
            flash?.({ type: 'success', text: t('modules.purchase_return_success') });
            if (ret.moduleId) { const id = ret.moduleId; setAwaitingIds((s) => new Set(s).add(id)); }
            refreshEnt.mutate(undefined, {
                onSuccess: (res) => {
                    const ids = res?.entitledModuleIds || [];
                    if (ids.length) {
                        setAwaitingIds((s) => { const n = new Set(s); for (const id of ids) n.delete(id); return n; });
                    }
                    reloadEntitlements();
                    refetch();
                },
            });
        } else {
            flash?.({ type: 'info', text: t('modules.purchase_return_cancel') });
        }
    });
    useEffect(() => { handlePurchaseReturn(); }, []);
}

interface AwaitingPollArgs {
    refreshEnt: ModuleActions['refreshEnt'];
    awaitingIds: ModuleActions['awaitingIds'];
    setAwaitingIds: ModuleActions['setAwaitingIds'];
    reloadEntitlements: () => void;
    refetch: () => void;
}

function useAwaitingPoll({ refreshEnt, awaitingIds, setAwaitingIds, reloadEntitlements, refetch }: AwaitingPollArgs) {
    // ── Background entitlement poll while a purchase is awaiting payment ──
    // Honest, no hub→install push: after Checkout opens we poll entitlements so
    // a completed payment flips the card to Install on its own; the explicit
    // "I've paid — refresh" button remains for impatient admins. A fixed 6s
    // cadence keeps this simple (the plan's tapering cadence is a refinement).
    const pollEntitlements = useEffectEvent(() => {
        if (refreshEnt.isPending) return;
        refreshEnt.mutate(undefined, {
            onSuccess: (res) => {
                const ids = res?.entitledModuleIds || [];
                if (ids.length) {
                    setAwaitingIds((s) => { const n = new Set(s); for (const id of ids) n.delete(id); return n; });
                }
                reloadEntitlements();
                refetch();
            },
        });
    });
    useEffect(() => {
        if (awaitingIds.size === 0) return undefined;
        const iv = setInterval(pollEntitlements, 6000);
        return () => clearInterval(iv);
    }, [awaitingIds.size]);
}

export default function MarketplaceTab({ flash, reloadEntitlements }: MarketplaceTabProps) {
    const { t } = useTranslation();
    const { tier } = useEntitlements();
    const licensed = !!tier && tier !== 'community';

    const [q, setQ] = useState('');
    const [debouncedQ, setDebouncedQ] = useState('');
    useEffect(() => {
        const h = setTimeout(() => setDebouncedQ(q.trim()), 350);
        return () => clearTimeout(h);
    }, [q]);

    const marketplace = useMarketplace(debouncedQ);
    const connectHub = useConnectHub();
    const disconnectHub = useDisconnectHub();

    // Shared buy/install/update/rollback/reactivate machinery — used by the
    // card grid AND the detail drawer so both surfaces behave identically.
    const actions = useModuleActions({
        flash,
        reloadEntitlements,
        refetchMarketplace: () => marketplace.refetch(),
    });
    const { refreshEnt, awaitingIds, setAwaitingIds, installing, progress } = actions;

    // Connect / disconnect confirm dialog: null | 'connect' | 'disconnect'.
    const [dialog, setDialog] = useState<'connect' | 'disconnect' | null>(null);
    const [dialogError, setDialogError] = useState<string | null>(null);

    // Detail drawer (card click / ?module=<id> deep link) + logs + sideload.
    const [detailId, setDetailId] = useState<string | null>(null);
    const [logsModule, setLogsModule] = useState<MarketplaceModuleDetail | null>(null);
    const [sideloadOpen, setSideloadOpen] = useState(false);

    // react-query keeps `data.pages` referentially stable until it changes, so
    // memoising over it (not a fresh `|| []`) avoids recomputing every render.
    const pages = marketplace.data?.pages;
    const first = pages?.[0];
    const connected = first?.connected;
    const stale = !!first?.stale;
    const hubUrl = first?.hubUrl;
    const modules = useMemo(() => (pages || []).flatMap((p) => p?.modules || []), [pages]);

    // Runtime health (quarantine / restart / sideload chips), joined by id.
    const healthQuery = useModulesHealth();
    const healthById = useMemo(() => {
        const map = new Map();
        for (const row of healthQuery.data?.modules || []) map.set(row.moduleId, row);
        return map;
    }, [healthQuery.data]);

    // Distinguish "hub down" (502) from "not connected" (a normal 200 payload).
    const hubUnavailable = marketplace.isError
        && ((marketplace.error as ModuleApiError | null)?.status === 502 || (marketplace.error as ModuleApiError | null)?.body?.error === 'hub_unavailable');
    const hubDetail = (marketplace.error as ModuleApiError | null)?.body?.details?.detail ?? (marketplace.error as ModuleApiError | null)?.body?.detail;

    usePurchaseReturn({ flash, t, refreshEnt, setAwaitingIds, reloadEntitlements, refetch: () => marketplace.refetch() });

    // ── ?module=<id> deep link → open the detail drawer on mount ──
    useEffect(() => {
        const id = parseModuleDeepLink(window.location.search);
        if (id) setDetailId(id);
    }, []);

    const openDetails = (module: MarketplaceModuleDetail) => {
        setDetailId(module.id);
        window.history.replaceState(null, '', searchWithModule(module.id));
    };
    const closeDetails = () => {
        setDetailId(null);
        window.history.replaceState(null, '', searchWithoutModule(window.location));
    };

    useAwaitingPoll({ refreshEnt, awaitingIds, setAwaitingIds, reloadEntitlements, refetch: () => marketplace.refetch() });

    const handleConnectConfirm = () => {
        setDialogError(null);
        connectHub.mutate({}, {
            onSuccess: () => {
                setDialog(null);
                reloadEntitlements();
                marketplace.refetch();
                flash?.({ type: 'success', text: t('modules.connect_success') });
            },
            onError: (e: ModuleApiError) => setDialogError(
                e?.status === 409 || e?.body?.error === 'already_connected'
                    ? t('modules.error_already_connected')
                    : t('modules.hub_unavailable'),
            ),
        });
    };

    const handleDisconnectConfirm = () => {
        setDialogError(null);
        disconnectHub.mutate(undefined, {
            onSuccess: () => { setDialog(null); reloadEntitlements(); marketplace.refetch(); },
            onError: () => setDialogError(t('modules.hub_unavailable')),
        });
    };

    const detailModule = detailId ? modules.find((m) => m.id === detailId) || null : null;

    const dialogNode = dialog && (
        <ConnectHubDialog
            mode={dialog}
            licensed={licensed}
            busy={connectHub.isPending || disconnectHub.isPending}
            error={dialogError}
            onCancel={() => { setDialog(null); setDialogError(null); }}
            onConfirm={dialog === 'disconnect' ? handleDisconnectConfirm : handleConnectConfirm}
        />
    );

    // Overlays for the connected view (consent can pop mid-install/update).
    const overlayNodes = (
        <MarketplaceOverlays actions={actions} sideloadOpen={sideloadOpen} setSideloadOpen={setSideloadOpen} logsModule={logsModule}
            setLogsModule={setLogsModule} detailModule={detailModule} healthById={healthById} closeDetails={closeDetails} />
    );

    // ── Render ──
    if (marketplace.isLoading) {
        return (
            <div className="flex items-center justify-center py-20" data-testid="marketplace-loading">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
            </div>
        );
    }

    if (hubUnavailable) {
        return <HubUnavailable t={t} hubDetail={hubDetail} onRetry={() => marketplace.refetch()} />;
    }

    if (connected === false) {
        return (
            <>
                {dialogNode}
                <ConnectHubBanner
                    licensed={licensed}
                    busy={connectHub.isPending}
                    onConnect={() => { setDialogError(null); setDialog('connect'); }}
                />
            </>
        );
    }

    return (
        <div className="space-y-4">
            {dialogNode}
            {overlayNodes}

            {/* Connection status row */}
            <MarketplaceTabSection t={t} hubUrl={hubUrl} setSideloadOpen={setSideloadOpen} setDialogError={setDialogError} setDialog={setDialog} />

            {stale && (
                <div className="text-xs px-3 py-2 rounded-lg flex items-center gap-2 [background:rgba(245,158,11,0.12)] [color:#f59e0b]!" data-testid="marketplace-stale">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {t('modules.marketplace_stale')}
                </div>
            )}

            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t('modules.marketplace_search')}
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm border outline-none transition-all [background:var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                />
            </div>

            {/* Grid */}
            {modules.length === 0 ? (
                <div className="text-center py-12" data-testid="marketplace-empty">
                    <p className="text-sm text-[var(--text-muted)]">{t('modules.empty')}</p>
                </div>
            ) : (
                <ModuleGrid modules={modules} healthById={healthById} awaitingIds={awaitingIds} installing={installing} progress={progress} actions={actions} onOpenDetails={openDetails} />
            )}

            {/* Load more */}
            {marketplace.hasNextPage && <LoadMore t={t} busy={marketplace.isFetchingNextPage} onMore={() => marketplace.fetchNextPage()} />}
        </div>
    );
}

function MarketplaceTabSection({ t, hubUrl, setSideloadOpen, setDialogError, setDialog }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; hubUrl: string | undefined; setSideloadOpen: Dispatch<SetStateAction<boolean>>; setDialogError: Dispatch<SetStateAction<string | null>>; setDialog: Dispatch<SetStateAction<"connect" | "disconnect" | null>>; }) {
    return <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Plug className="w-3.5 h-3.5 [color:#10b981]" />
            {t('modules.connected_to', { hub: hubUrl || '' })}
        </div>
        <div className="flex items-center gap-3">
            <button
                onClick={() => setSideloadOpen(true)}
                className="text-xs font-medium hover:opacity-80 flex items-center gap-1 text-[var(--text-secondary)]"
                data-testid="sideload-open"
            >
                <FileUp className="w-3.5 h-3.5" /> {t('modules.sideload')}
            </button>
            <button
                onClick={() => { setDialogError(null); setDialog('disconnect'); } }
                className="text-xs font-medium hover:opacity-80 text-[var(--text-secondary)]"
            >
                {t('modules.disconnect')}
            </button>
        </div>
    </div>;
}
