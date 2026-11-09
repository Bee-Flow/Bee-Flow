import { Boxes, RefreshCw, Store } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import MarketplaceTab from './MarketplaceTab';
import ModuleCard from './ModuleCard';
import RemoveModuleDialog from './RemoveModuleDialog';
import { useAdminModules, useImportModule, useRemoveModule } from '@/api/queries/modules';
import { type AdminModule } from '@/api/queries/modules.types';
import { useTranslation } from '@/hooks/useTranslation';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import EmptyState from '@/components/shared/EmptyState';
import SectionHeader from '@/components/shared/SectionHeader';
import Spinner from '@/components/shared/Spinner';
import Tabs from '@/components/shared/Tabs';
import { ALERT_ERROR, ALERT_INFO, ALERT_SUCCESS, CHIP_SUCCESS } from '@/components/mcpLibrary/ui';

/** The look of a flash message, by its type. */
const FLASH_CLASS: Record<string, string> = { success: ALERT_SUCCESS, info: ALERT_INFO, error: ALERT_ERROR };

export default function ModulesPanel() {
    const { t } = useTranslation();
    const { data: modules = [], isLoading, isError, refetch } = useAdminModules();
    const importModule = useImportModule();
    const removeModule = useRemoveModule();
    const { reload: reloadEntitlements } = useEntitlements();

    // 'installed' | 'marketplace' — ?tab=marketplace opens the marketplace
    // directly (Stripe Checkout return URLs rely on this to land the customer
    // back on the tab that handles ?purchase=…).
    const [tab, setTab] = useState(() => (
        new URLSearchParams(window.location.search).get('tab') === 'marketplace' ? 'marketplace' : 'installed'
    ));
    const [message, setMessage] = useState<{ type: string; text: string } | null>(null);
    const [removeTarget, setRemoveTarget] = useState<AdminModule | null>(null);

    const flashTimer = useRef<NodeJS.Timeout>(null);
    useEffect(() => () => clearTimeout(flashTimer.current as NodeJS.Timeout), []);
    const flash = (msg: { type: string; text: string }) => {
        setMessage(msg);
        clearTimeout(flashTimer.current as NodeJS.Timeout);
        flashTimer.current = setTimeout(() => setMessage(null), 3000);
    };

    // The API layer surfaces wire error slugs as the Error message — translate
    // the known ones instead of flashing the raw slug.
    const errorText = (e: Error, fallback: string) => {
        if (e?.message === 'module_unavailable') return t('modules.error_unavailable');
        if (e?.message === 'not_found') return t('modules.error_not_found');
        return e?.message || fallback;
    };

    const handleImport = (module: AdminModule) => {
        importModule.mutate(module.id, {
            onSuccess: () => {
                // Refresh the acting super-admin's own entitlements so the
                // module's surfaces (e.g. its Studio tab) appear without a
                // page reload. Other members pick it up on their next reload.
                reloadEntitlements();
                flash({ type: 'success', text: t('modules.import_success', { name: module.name }) });
            },
            onError: (e) => flash({ type: 'error', text: errorText(e, 'Import failed') }),
        });
    };

    const handleRemoveConfirm = () => {
        const module = removeTarget;
        if (!module) return;
        removeModule.mutate(module.id, {
            onSuccess: () => {
                setRemoveTarget(null);
                reloadEntitlements();
                flash({ type: 'success', text: t('modules.remove_success', { name: module.name }) });
            },
            onError: (e) => {
                setRemoveTarget(null);
                flash({ type: 'error', text: errorText(e, 'Remove failed') });
            },
        });
    };

    const importedCount = modules.filter(m => m.status === 'imported').length;

    const TABS = [
        { id: 'installed', label: t('modules.tab_installed'), icon: <Boxes className="h-3.5 w-3.5" aria-hidden="true" /> },
        { id: 'marketplace', label: t('modules.tab_marketplace'), icon: <Store className="h-3.5 w-3.5" aria-hidden="true" /> },
    ];

    return (
        <div className="flex flex-col gap-5">
            {removeTarget && (
                <RemoveModuleDialog
                    module={removeTarget}
                    busy={removeModule.isPending}
                    onCancel={() => setRemoveTarget(null)}
                    onConfirm={handleRemoveConfirm}
                />
            )}

            <SectionHeader
                title={t('modules.title')}
                description={<>{t('modules.subtitle')} {t('modules.members_reload_hint')}</>}
                status={importedCount > 0 ? <span className={CHIP_SUCCESS}>{t('modules.imported_count', { count: importedCount })}</span> : null}
            />

            {/* Installed | Marketplace tabs */}
            <Tabs value={tab} onChange={setTab} items={TABS} size="sm" ariaLabel={t('modules.title')} />

            {/* Success / info / error flash */}
            {message && (
                <div className={FLASH_CLASS[message.type] ?? ALERT_ERROR} role="status">
                    {message.text}
                </div>
            )}

            {tab === 'marketplace' ? (
                <MarketplaceTab flash={flash} reloadEntitlements={reloadEntitlements} />
            ) : isLoading ? (
                <div className="flex items-center justify-center py-20" data-testid="modules-loading">
                    <Spinner />
                </div>
            ) : isError ? (
                <div className={`${ALERT_ERROR} items-center justify-between`} data-testid="modules-error">
                    <span>{t('modules.error_load')}</span>
                    <button type="button" onClick={() => refetch()} className="flex items-center gap-1 font-medium hover:opacity-80">
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> {t('modules.retry')}
                    </button>
                </div>
            ) : modules.length === 0 ? (
                <div data-testid="modules-empty">
                    <EmptyState
                        className="h-auto rounded-lg border border-dashed border-[var(--border-default)]"
                        icon={<Boxes className="h-8 w-8" strokeWidth={1.5} />}
                        title={t('modules.empty')}
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {modules.map(module => (
                        <ModuleCard
                            key={module.id}
                            module={module}
                            onImport={handleImport}
                            onRemoveRequest={setRemoveTarget}
                            busy={
                                (importModule.isPending && importModule.variables === module.id) ||
                                (removeModule.isPending && removeModule.variables === module.id)
                            }
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
