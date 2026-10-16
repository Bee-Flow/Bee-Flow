import { History, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { HeaderApp } from './headerModel';
import useTranslation from '../../../../../../hooks/useTranslation';
import Modal from '../../../../../shared/Modal';
import toast from '../../../../../shared/Toast';
import type { AppDefinition } from '../../inspector/appDefinition';
import { studioAppsApi } from '../../studioAppsApi';
import { errorMessage } from '../../../../../../utils/caughtError';

/** One saved version, as listVersions returns it (legacy snake_case included). */
interface VersionEntry {
    id?: string | number;
    versionId?: string | number;
    version?: string | number;
    label?: string;
    createdAt?: string;
    created_at?: string;
    createdByName?: string;
}

const versionIdOf = (entry: VersionEntry) => entry.id ?? entry.versionId ?? entry.version;

interface VersionHistoryModalProps {
    open: boolean;
    onClose: () => void;
    app: HeaderApp;
    isManaged: boolean;
    /** A refused write (409 managed_part) turns the header read-only. */
    noteRefusal: (err: unknown) => boolean;
    onServerDefinition?: (definition: AppDefinition | null | undefined, version: unknown) => void;
    onAppUpdated?: (app: HeaderApp) => void;
}

function errorText(err: unknown): string | undefined {
    const message = errorMessage(err);
    return typeof message === 'string' && message ? message : undefined;
}

/** The version history: listed while open, any entry restorable unless managed. */
export default function VersionHistoryModal({
    open, onClose, app, isManaged, noteRefusal, onServerDefinition, onAppUpdated,
}: VersionHistoryModalProps) {
    const { t } = useTranslation();
    const [versions, setVersions] = useState<VersionEntry[] | null>(null); // null = loading
    const [restoringId, setRestoringId] = useState<string | number | null | undefined>(null);
    useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        setVersions(null);
        studioAppsApi.listVersions(app.id)
            .then((res: { versions?: VersionEntry[] } | VersionEntry[] | null) => {
                if (alive) setVersions((res as { versions?: VersionEntry[] } | null)?.versions || (Array.isArray(res) ? res : []));
            })
            .catch((err: unknown) => {
                if (!alive) return;
                setVersions([]);
                toast.error(errorText(err) || t('app_studio.header.versions_failed', 'Could not load versions.'));
            });
        return () => { alive = false; };
    }, [open, app?.id, t]);

    const doRestore = async (versionEntry: VersionEntry) => {
        if (isManaged) return;
        const versionId = versionIdOf(versionEntry);
        setRestoringId(versionId);
        try {
            await studioAppsApi.restoreVersion(app.id, versionId);
            const fresh = await studioAppsApi.getApp(app.id);
            const freshApp: HeaderApp = fresh?.app || fresh;
            // The app row exposes the optimistic-concurrency version as
            // `definitionVersion` (studioApps.js → sanitizeAppRow); `version` is
            // only there for callers that already normalised it. Handing over
            // undefined leaves autosave on a stale baseVersion → conflict loop.
            onServerDefinition?.(freshApp.definition, freshApp.version ?? freshApp.definitionVersion);
            onAppUpdated?.(freshApp);
            onClose();
            toast.success(t('app_studio.header.version_restored', 'Version restored.'));
        } catch (err) {
            noteRefusal(err);
            toast.error(errorText(err) || t('app_studio.header.restore_failed', 'Restore failed.'));
        } finally {
            setRestoringId(null);
        }
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            title={t('app_studio.header.version_history', 'Version history')}
            description={isManaged
                ? t('managed_part.read_only_hint', 'Read-only: this part is managed by a Solution stage.')
                : t('app_studio.header.versions_desc', 'Restoring creates a new version — nothing is lost.')}
            size="lg"
        >
            {versions === null ? (
                <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-tertiary)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('app_studio.header.versions_loading', 'Loading versions…')}
                </div>
            ) : versions.length === 0 ? (
                <p className="py-6 text-center text-sm text-[var(--text-tertiary)]">
                    {t('app_studio.header.versions_empty', 'No saved versions yet — versions appear when the app is published or restored.')}
                </p>
            ) : (
                <ul className="divide-y border-[var(--border-default)]">
                    {versions.map((entry) => {
                        const versionId = versionIdOf(entry);
                        const createdAt = entry.createdAt || entry.created_at;
                        return (
                            <li key={versionId} className="flex items-center gap-3 py-2.5">
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-[var(--text-primary)]">
                                        {entry.label || t('app_studio.header.version_n', 'Version {n}', { n: entry.version ?? versionId })}
                                    </div>
                                    <div className="text-xs text-[var(--text-tertiary)]">
                                        {createdAt ? new Date(createdAt).toLocaleString() : ''}
                                        {entry.createdByName ? ` · ${entry.createdByName}` : ''}
                                    </div>
                                </div>
                                {!isManaged && (
                                <button
                                    type="button"
                                    disabled={restoringId != null}
                                    onClick={() => doRestore(entry)}
                                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]"
                                >
                                    {restoringId === versionId
                                        ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                        : <History className="h-3 w-3" aria-hidden="true" />}
                                    {t('app_studio.header.restore', 'Restore')}
                                </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </Modal>
    );
}
