import {
    AlertCircle,
    ExternalLink,
    LayoutGrid,
    Loader2,
    Plus,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { CardBody, SkeletonGrid } from './list/AppCard';
import { CARD_CLASSES, CARD_STYLE } from './list/cardStyle';
import NewAppModal from './list/NewAppModal';
import OwnerMenu from './list/OwnerMenu';
import { studioAppsApi } from './studioAppsApi';
import useTranslation, { TranslateParams } from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EmptyState from '@/components/shared/EmptyState';
import Modal from '@/components/shared/Modal';
import toast from '@/components/shared/Toast';
import type { StudioApp, OpenOptions } from './list/types';

/**
 * App Studio — the Apps gallery (Studio section landing view).
 *
 * Merges listAccessible() + listMine() (deduped by id, owned first). Owner
 * cards open the editor via onOpen(app) and carry a kebab (Open / Rename /
 * Delete); shared (non-owner) cards are plain anchors to the end-user run
 * view at /app/apps/<id>. "New app" opens a three-tab modal: start blank, pick
 * from the server template gallery, or bring a template file somebody handed
 * you (server: appStudio/templatePortability.js). A gallery card can be written
 * back out to a file the same way, which is the other half of the same idea:
 * a template built here should be able to reach an installation over there.
 *
 * Props:
 *   onOpen(app, openOptions?) — open an app in the editor (owner cards + fresh
 *     creations). openOptions is optional; a "Remix with AI" template card
 *     passes { remix:true, templateId, prompt } so the editor can focus the AI
 *     builder with a prefilled prompt. Plain opens omit it.
 */


// ── The gallery ─────────────────────────────────────────────────────

interface AppListProps {
    onOpen: (app: { id?: string; } | null | undefined, openOptions?: { remix?: boolean; prompt?: string; }) => void;
}

export default function AppList({ onOpen }: AppListProps) {
    const { t } = useTranslation();
    const [apps, setApps] = useState<StudioApp[]>([]);
    const [ownedIds, setOwnedIds] = useState(() => new Set<string>());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [showCreate, setShowCreate] = useState(false);
    const [renameTarget, setRenameTarget] = useState<StudioApp | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renameBusy, setRenameBusy] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<StudioApp | null>(null);
    const [upgradeTarget, setUpgradeTarget] = useState<StudioApp | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [accessible, mine] = await Promise.all([
                studioAppsApi.listAccessible(),
                studioAppsApi.listMine(),
            ]);
            const mineApps = mine?.apps || [];
            const owned = new Set<string>(mineApps.map((a: StudioApp) => a.id));
            const byUpdated = (a: StudioApp, b: StudioApp) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
            const shared = (accessible?.apps || []).filter((a: StudioApp) => !owned.has(a.id));
            setApps([...[...mineApps].sort(byUpdated), ...shared.sort(byUpdated)]);
            setOwnedIds(owned);
        } catch (err) {
            setError((err as Error)?.message || t('studio_apps_bi.list.load_failed', 'Could not load your apps.'));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => { load(); }, [load]);

    const startRename = (app: StudioApp) => {
        setRenameTarget(app);
        setRenameValue(app.name || '');
    };

    const submitRename = async (e: React.MouseEvent<HTMLButtonElement, MouseEvent> | React.SubmitEvent<HTMLFormElement>) => {
        e?.preventDefault?.();
        if (!renameTarget || renameBusy) return;
        const trimmed = renameValue.trim();
        if (!trimmed || trimmed === renameTarget.name) { setRenameTarget(null); return; }
        setRenameBusy(true);
        try {
            const res = await studioAppsApi.updateApp(renameTarget.id, { name: trimmed });
            const updated = res?.app || { ...renameTarget, name: trimmed };
            setApps((prev) => prev.map((a) => (a.id === renameTarget.id ? { ...a, ...updated } : a)));
            setRenameTarget(null);
            toast.success(t('studio_apps_bi.list.renamed', 'App renamed.'));
        } catch (err) {
            toast.error((err as Error)?.message || t('studio_apps_bi.list.rename_failed', 'Could not rename the app.'));
        } finally {
            setRenameBusy(false);
        }
    };

    // Template upgrade — confirmed first (the definition is replaced), then
    // the list reloads so the pill disappears and the card shows the result.
    const confirmUpgrade = async () => {
        if (!upgradeTarget) return;
        try {
            await studioAppsApi.templateUpgrade(upgradeTarget.id);
            toast.success(t('studio_apps_bi.list.upgraded', 'App updated to the latest template version.'));
            load();
        } catch (err) {
            toast.error((err as Error)?.message || t('studio_apps_bi.list.upgrade_failed', 'Could not update the app.'));
        } finally {
            setUpgradeTarget(null);
        }
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        try {
            await studioAppsApi.deleteApp(deleteTarget.id);
            setApps((prev) => prev.filter((a) => a.id !== deleteTarget.id));
            toast.success(t('studio_apps_bi.list.deleted', 'App deleted.'));
        } catch (err) {
            toast.error((err as Error)?.message || t('studio_apps_bi.list.delete_failed', 'Could not delete the app.'));
        } finally {
            setDeleteTarget(null);
        }
    };

    // openOptions (e.g. { remix, templateId, prompt }) is forwarded to the
    // opener so a remix can focus the AI builder with a prefilled prompt. Plain
    // opens keep the single-arg onOpen(app) signature.
    const handleCreated = (app: StudioApp, openOptions: OpenOptions | undefined) => {
        setShowCreate(false);
        if (openOptions) onOpen?.(app, openOptions);
        else onOpen?.(app);
    };

    const isEmpty = !loading && !error && apps.length === 0;

    return (
        <div className="flex flex-col h-full [background:var(--bg-primary)]">
            {/* Toolbar */}
            <div
                className="shrink-0 px-4 py-3 border-b flex items-center gap-3 [border-color:var(--border-subtle)]!"
            >
                <div className="flex-1 flex items-center gap-2 min-w-0">
                    <LayoutGrid className="w-5 h-5 shrink-0 text-[var(--accent-primary)]" />
                    <h2 className="text-lg font-semibold truncate text-[var(--text-primary)]">{t('studio_apps_bi.list.apps', 'Apps')}</h2>
                </div>
                <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    className="px-3 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-1.5 [background:var(--accent-primary)]"
                >
                    <Plus className="w-3.5 h-3.5" />
                    {t('studio_apps_bi.list.new_app', 'New app')}
                </button>
            </div>

            {error && (
                <div
                    className="shrink-0 px-4 py-2 text-xs flex items-center gap-2 [background:rgba(239,68,68,0.1)] [color:#991b1b]!"
                    role="alert"
                >
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
                    <button type="button" onClick={load} className="ml-auto underline font-medium">{t('studio_apps_bi.list.retry', 'Retry')}</button>
                </div>
            )}

            <AppListSection loading={loading} isEmpty={isEmpty} t={t} setShowCreate={setShowCreate} apps={apps} ownedIds={ownedIds} onOpen={onOpen} setUpgradeTarget={setUpgradeTarget} startRename={startRename} setDeleteTarget={setDeleteTarget} />

            <NewAppModal
                open={showCreate}
                onClose={() => setShowCreate(false)}
                onCreated={handleCreated}
            />

            <Modal
                open={!!renameTarget}
                onClose={() => { if (!renameBusy) setRenameTarget(null); }}
                title={t('studio_apps_bi.list.rename_app', 'Rename app')}
                size="sm"
                footer={
                    <>
                        <button
                            type="button"
                            onClick={() => setRenameTarget(null)}
                            disabled={renameBusy}
                            className="px-4 py-2 rounded-lg text-sm bg-white/5 hover:bg-[var(--bg-card-hover)] disabled:opacity-50 [color:var(--text-primary)]!"
                        >
                            {t('studio_apps_bi.common.cancel', 'Cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={submitRename}
                            disabled={renameBusy || !renameValue.trim()}
                            className="px-4 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-1.5 disabled:opacity-50 [background:var(--accent-primary)]"
                        >
                            {renameBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            {t('studio_apps_bi.list.save', 'Save')}
                        </button>
                    </>
                }
            >
                <form onSubmit={submitRename}>
                    <input
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        aria-label={t('studio_apps_bi.list.app_name', 'App name')}
                        maxLength={120}
                        autoFocus
                        className="w-full px-3 py-2 text-sm rounded-lg border outline-none focus:ring-2 [border-color:var(--border-subtle)] [background:var(--bg-primary)] [color:var(--text-primary)]!"
                    />
                </form>
            </Modal>

            <ConfirmDialog
                open={!!upgradeTarget}
                title={t('studio_apps_bi.list.upgrade_confirm_title', 'Update “{name}”?', { name: upgradeTarget?.name || t('studio_apps_bi.list.app_fallback', 'App') })}
                description={t('studio_apps_bi.list.upgrade_confirm_desc', 'The app is updated to the latest template version. Your data stays.')}
                confirmLabel={t('studio_apps_bi.list.upgrade_confirm', 'Update')}
                onConfirm={confirmUpgrade}
                onCancel={() => setUpgradeTarget(null)}
            />

            <ConfirmDialog
                open={!!deleteTarget}
                title={t('studio_apps_bi.list.delete_confirm_title', 'Delete “{name}”?', { name: deleteTarget?.name || t('studio_apps_bi.list.app_fallback_lower', 'app') })}
                description={t('studio_apps_bi.list.delete_confirm_desc', 'This permanently deletes the app and its version history for everyone it is shared with. This cannot be undone.')}
                confirmLabel={t('studio_apps_bi.list.delete', 'Delete')}
                destructive
                onConfirm={confirmDelete}
                onCancel={() => setDeleteTarget(null)}
            />
        </div>
    );
}

function AppListSection({ loading, isEmpty, t, setShowCreate, apps, ownedIds, onOpen, setUpgradeTarget, startRename, setDeleteTarget }: { loading: boolean; isEmpty: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; setShowCreate: React.Dispatch<React.SetStateAction<boolean>>; apps: StudioApp[]; ownedIds: Set<string>; onOpen: (app: { id?: string; } | null | undefined, openOptions?: { remix?: boolean; prompt?: string; }) => void; setUpgradeTarget: React.Dispatch<React.SetStateAction<StudioApp | null>>; startRename: (app: StudioApp) => void; setDeleteTarget: React.Dispatch<React.SetStateAction<StudioApp | null>>; }) {
    return <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
        {loading ? (
            <SkeletonGrid />
        ) : isEmpty ? (
            <EmptyState
                icon={<LayoutGrid className="w-12 h-12" />}
                title={t('studio_apps_bi.list.empty_title', 'Build your first app')}
                description={t('studio_apps_bi.list.empty_desc', 'Turn an automation into a small internal tool — a form, a dashboard, a tracker — without writing code. Describe what you need and the AI can build it for you.')}
                action={{
                    label: t('studio_apps_bi.list.new_app', 'New app'),
                    onClick: () => setShowCreate(true),
                    icon: <Plus className="w-4 h-4" />,
                }} />
        ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {apps.map((app) => {
                    const owned = ownedIds.has(app.id);
                    if (!owned) {
                        // Shared with me — open the end-user run view
                        // at /app/apps/:id (AppRunPage).
                        return (
                            <a
                                key={app.id}
                                href={`/app/apps/${app.id}`}
                                className={`${CARD_CLASSES} block no-underline`}
                                style={CARD_STYLE}
                            >
                                <CardBody app={app} />
                                <span
                                    className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity text-[var(--text-secondary)]"
                                >
                                    {t('studio_apps_bi.list.open', 'Open')} <ExternalLink className="w-3 h-3" />
                                </span>
                            </a>
                        );
                    }
                    return (
                        <div
                            key={app.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => onOpen?.(app)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onOpen?.(app);
                                }
                            } }
                            className={`${CARD_CLASSES} cursor-pointer`}
                            style={CARD_STYLE}
                        >
                            <CardBody app={app} onUpgrade={setUpgradeTarget} />
                            <OwnerMenu
                                app={app}
                                onOpen={() => onOpen?.(app)}
                                onRename={() => startRename(app)}
                                onDelete={() => setDeleteTarget(app)} />
                        </div>
                    );
                })}
            </div>
        )}
    </div>;
}
