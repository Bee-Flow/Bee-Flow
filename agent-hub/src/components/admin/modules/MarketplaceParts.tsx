import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ComponentProps, Dispatch, SetStateAction } from 'react';
import type { MarketplaceModuleDetail } from '@/api/queries/modules.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import MarketplaceModuleCard from './MarketplaceModuleCard';
import ModuleDetailDrawer from './ModuleDetailDrawer';
import ModuleLogsDialog from './ModuleLogsDialog';
import PermissionConsentDialog from './PermissionConsentDialog';
import SideloadDialog from './SideloadDialog';
import type { useModuleActions } from './moduleActions';

// The marketplace tab's grid, its overlays, the hub-down notice and Load more.

type ModuleActions = ReturnType<typeof useModuleActions>;
type HealthById = Map<string, ComponentProps<typeof MarketplaceModuleCard>['health']>;

interface MarketplaceOverlaysProps {
    actions: ModuleActions;
    sideloadOpen: boolean;
    setSideloadOpen: Dispatch<SetStateAction<boolean>>;
    logsModule: MarketplaceModuleDetail | null;
    setLogsModule: Dispatch<SetStateAction<MarketplaceModuleDetail | null>>;
    detailModule: MarketplaceModuleDetail | null;
    healthById: HealthById;
    closeDetails: () => void;
}

/** The consent dialog, the sideload dialog, the logs dialog and the detail drawer, each when it is open. */
export function MarketplaceOverlays({ actions, sideloadOpen, setSideloadOpen, logsModule, setLogsModule, detailModule, healthById, closeDetails }: MarketplaceOverlaysProps) {
    return (
        <>
            {actions.consent && (
                <PermissionConsentDialog
                    module={actions.consent.module}
                    permissions={actions.consent.permissions}
                    mode={actions.consent.mode}
                    busy={actions.install.isPending || actions.update.isPending}
                    onCancel={() => actions.setConsent(null)}
                    onAccept={actions.acceptConsent}
                />
            )}
            {sideloadOpen && (
                <SideloadDialog
                    onClose={() => setSideloadOpen(false)}
                    onDone={() => actions.refreshAll()}
                />
            )}
            {logsModule && <ModuleLogsDialog module={logsModule} onClose={() => setLogsModule(null)} />}
            {detailModule && (
                <ModuleDetailDrawer
                    module={detailModule}
                    health={healthById.get(detailModule.id) || null}
                    actions={actions}
                    onClose={closeDetails}
                    onOpenLogs={(m) => setLogsModule(m)}
                />
            )}
        </>
    );
}

/** The hub answered 502 (or hub_unavailable): say so, with the detail when there is one, and offer a retry. */
export function HubUnavailable({ t, hubDetail, onRetry }: { t: TranslateFn; hubDetail: string | undefined; onRetry: () => void }) {
    return (
        <div className="space-y-3">
            <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-400 flex items-center gap-2" data-testid="marketplace-hub-unavailable">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t('modules.hub_unavailable')}{hubDetail ? ` (${hubDetail})` : ''}</span>
            </div>
            <button
                onClick={onRetry}
                className="text-xs font-medium flex items-center gap-1 hover:opacity-80 text-[var(--accent-primary)]"
            >
                {t('modules.retry')}
            </button>
        </div>
    );
}

interface ModuleGridProps {
    modules: MarketplaceModuleDetail[];
    healthById: HealthById;
    awaitingIds: ModuleActions['awaitingIds'];
    installing: ModuleActions['installing'];
    progress: ModuleActions['progress'];
    actions: ModuleActions;
    onOpenDetails: (module: MarketplaceModuleDetail) => void;
}

/** The module cards. */
export function ModuleGrid({ modules, healthById, awaitingIds, installing, progress, actions, onOpenDetails }: ModuleGridProps) {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {modules.map((module) => (
                <MarketplaceModuleCard
                    key={module.id}
                    module={module}
                    health={healthById.get(module.id) || null}
                    awaiting={awaitingIds.has(module.id)}
                    installProgress={installing?.id === module.id ? progress.data : null}
                    busy={actions.busyFor(module)}
                    onBuy={actions.buy}
                    onInstall={actions.installModule}
                    onUpdate={actions.updateModule}
                    onPaidRefresh={actions.paidRefresh}
                    onReactivate={actions.reactivateModule}
                    onOpenDetails={onOpenDetails}
                    onPolicyChange={actions.setPolicy}
                    policyBusy={actions.updatePolicy.isPending}
                />
            ))}
        </div>
    );
}

/** The next page of the marketplace listing. */
export function LoadMore({ t, busy, onMore }: { t: TranslateFn; busy: boolean; onMore: () => void }) {
    return (
        <div className="flex justify-center">
            <button
                onClick={onMore}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-xs font-medium transition-all border disabled:opacity-50 flex items-center gap-1.5 bg-[var(--bg-secondary)] text-[var(--text-primary)] border-[var(--border-default)]"
            >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('modules.load_more')}
            </button>
        </div>
    );
}
