import { ChevronDown, Folder, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import CloudFolderPicker from './CloudFolderPicker';
import { refreshModeKey } from './freshness';
import { knowledgeApi, type CloudItem, type CloudProvider } from './knowledgeApi';
import ScheduleMenu, { type ScheduleChange } from './ScheduleMenu';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import { providerName } from '../Datatables/datatableDisplay';
import { ssReasonText } from '../Datatables/spreadsheet/wizardState';
import type { FormProps, NewSource } from './AddSourcePanel.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The refresh modes a cloud folder offers; `on_change` is the one the others do not have. */
const CLOUD_REFRESH_MODES = ['manual', 'schedule', 'on_change'];

/** The request body for the chosen folder and refresh rule. */
function bodyFor(provider: string, folder: CloudItem, recursive: boolean, refresh: ScheduleChange): NewSource {
    return {
        kind: 'cloud_folder',
        config: {
            provider,
            folderId: folder.fileId,
            ...(folder.driveId ? { driveId: folder.driveId } : {}),
            ...(folder.path ? { path: folder.path } : {}),
            folderName: folder.name,
            recursive,
        },
        refresh: {
            mode: refresh.mode,
            ...(refresh.cron ? { cron: refresh.cron } : {}),
            ...(refresh.tz ? { tz: refresh.tz } : {}),
        },
    };
}

/**
 * A folder in a cloud, and how it stays in step.
 *
 * ── A CLOUD THAT IS NOT CONNECTED IS SHOWN, NOT HIDDEN ──────────────
 * Same rule as the source buttons: a person with only Nextcloud connected must
 * still see that OneDrive and Google Drive exist, greyed, with the sentence that
 * says where to connect them. Hiding them teaches that the product cannot.
 */
export default function CloudFolderForm({ t, busy, onSubmit }: FormProps) {
    const [providers, setProviders] = useState<CloudProvider[] | null>(null);   // null = loading
    const [provider, setProvider] = useState('');
    const [folder, setFolder] = useState<CloudItem | null>(null);
    const [recursive, setRecursive] = useState(true);
    const [refresh, setRefresh] = useState<ScheduleChange>({ mode: 'manual' });

    useEffect(() => {
        let alive = true;
        knowledgeApi.cloudProviders()
            .then((b) => { if (alive) setProviders(Array.isArray(b?.providers) ? b.providers : []); })
            .catch(() => { if (alive) setProviders([]); });
        return () => { alive = false; };
    }, []);

    if (providers === null) {
        return (
            <p className="flex items-center gap-2 text-[var(--text-tertiary)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                {t('knowledge.cloud.loading_providers', 'Checking your connected clouds…')}
            </p>
        );
    }

    return (
        <form
            className="flex flex-col gap-2.5"
            data-testid="kb-form-cloud_folder"
            onSubmit={(e) => { e.preventDefault(); if (folder && provider) onSubmit(bodyFor(provider, folder, recursive, refresh)); }}
        >
            <ProviderChoice t={t} providers={providers} value={provider} onPick={(p) => { if (p !== provider) { setProvider(p); setFolder(null); } }} />

            {provider && !folder && <CloudFolderPicker key={provider} t={t} provider={provider} onChoose={setFolder} />}

            {provider && folder && (
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-[10px] [border:1px_solid_var(--border-default)]" data-testid="kb-cloud-chosen">
                    <Folder className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                    <span className="truncate text-[var(--text-primary)]">{folder.name}</span>
                    <button type="button" onClick={() => setFolder(null)} className="ml-auto shrink-0 underline-offset-2 hover:underline text-[var(--text-secondary)]">
                        {t('knowledge.cloud.change_folder', 'Change')}
                    </button>
                </div>
            )}

            {folder && (
                <>
                    <label className="flex items-center gap-2">
                        <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} data-testid="kb-cloud-recursive" />
                        {t('knowledge.cloud.recursive', 'Include subfolders')}
                    </label>
                    <RefreshChoice t={t} refresh={refresh} onChange={setRefresh} />
                </>
            )}

            <p className="text-[var(--text-tertiary)] text-[11px]">
                {t('knowledge.cloud.consequence', 'Everyone who can see this knowledge base can search what is in this folder, whether or not they can open it in the cloud themselves.')}
            </p>

            <button
                type="submit"
                disabled={busy || !folder}
                data-testid="kb-cloud-submit"
                className="self-start px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
            >
                {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                {t('knowledge.cloud.submit', 'Add this folder')}
            </button>
        </form>
    );
}

/** One radio per cloud; the ones that are not connected stay, disabled, with their reason. */
function ProviderChoice({ t, providers, value, onPick }: { t: TranslateFn; providers: CloudProvider[]; value: string; onPick: (provider: string) => void }) {
    return (
        <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[var(--text-secondary)] mb-1">{t('knowledge.cloud.provider_label', 'Which cloud?')}</legend>
            {providers.length === 0 && (
                <p className="text-[var(--text-tertiary)]">{t('knowledge.cloud.no_providers', 'No cloud storage is available for this account.')}</p>
            )}
            <div role="radiogroup" aria-label={t('knowledge.cloud.provider_label', 'Which cloud?')} className="flex flex-col gap-1.5">
                {providers.map(p => (
                    <div key={p.provider} className="flex flex-col gap-0.5">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={value === p.provider}
                            disabled={!p.connected}
                            onClick={() => onPick(p.provider)}
                            data-testid={`kb-cloud-provider-${p.provider}`}
                            className={`flex items-center gap-2 px-2.5 py-2 rounded-[10px] text-left disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 [color:var(--text-primary)]! [outline-color:var(--accent-primary)]! ${value === p.provider ? '[border:1px_solid_var(--accent-primary)]' : '[border:1px_solid_var(--border-default)]'}`}
                        >
                            {providerName(p.provider)}
                        </button>
                        {!p.connected && (
                            <span className="text-[11px] text-[var(--text-tertiary)]">{ssReasonText(t, { provider: p.provider, reason: p.reason ?? undefined })}</span>
                        )}
                    </div>
                ))}
            </div>
        </fieldset>
    );
}

/** The refresh rule, through the same menu a source uses, with `on_change` offered too. */
function RefreshChoice({ t, refresh, onChange }: { t: TranslateFn; refresh: ScheduleChange; onChange: (next: ScheduleChange) => void }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLButtonElement>(null);
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[var(--text-secondary)]">{t('knowledge.cloud.refresh_label', 'Keep it up to date')}</span>
            <button
                ref={ref}
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="kb-cloud-refresh"
                className="self-start inline-flex items-center gap-2 h-8 px-3 rounded-[10px] text-xs [border:1px_solid_var(--border-default)] [background:var(--bg-card)] [color:var(--text-primary)]!"
            >
                {t('knowledge.sources.refresh_label', 'Refresh: {mode}', { mode: t(refreshModeKey(refresh.mode), refresh.mode) })}
                <ChevronDown className="w-3 h-3 text-[var(--text-tertiary)]" aria-hidden="true" />
            </button>
            <ScheduleMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={ref}
                align="left"
                source={{ supportsModes: CLOUD_REFRESH_MODES, refreshMode: refresh.mode, refreshCron: refresh.cron, refreshTz: refresh.tz }}
                onChange={onChange}
            />
        </div>
    );
}
