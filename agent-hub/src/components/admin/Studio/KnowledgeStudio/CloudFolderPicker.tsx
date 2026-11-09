import { ChevronRight, File as FileIcon, Folder, Loader2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { cloudErrorOr } from './cloudErrors';
import { knowledgeApi, type CloudItem } from './knowledgeApi';
import { providerName } from '../Datatables/datatableDisplay';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * Pick ONE FOLDER in a cloud (Nextcloud, OneDrive, Google Drive).
 *
 * The folder-mode sibling of the datatables' spreadsheet `FileBrowser`. That one
 * is built around ticking spreadsheet files across storages (a global selection,
 * tabs per storage, `datatablesApi`); here the answer is a single folder of ONE
 * already-chosen storage, so it is a small component of its own that keeps the
 * same reading habits: a breadcrumb, folders you walk into, and files shown
 * greyed for context so a person can see they are in the right place.
 *
 * Mount it with `key={provider}`: a different cloud starts again at its root.
 *
 * The browse route hides what an id is (`fileId`, `driveId`, `path`); this never
 * reads one, it hands back the entry it was given.
 */
export interface CloudFolderPickerProps {
    t: TranslateFn;
    provider: string;
    onChoose: (folder: CloudItem) => void;
}

interface PickerState {
    items: CloudItem[];
    next: string | null;
    loading: boolean;
    error: string | null;
}

/** One folder's listing, re-read whenever the folder (or the cloud) changes. */
function useListing(t: TranslateFn, provider: string, here: CloudItem | null) {
    const [state, setState] = useState<PickerState>({ items: [], next: null, loading: true, error: null });
    const [moreBusy, setMoreBusy] = useState(false);
    // The listing must not re-read when the translator's identity changes.
    const tRef = useRef(t);
    tRef.current = t;
    const failure = (e: unknown) => cloudErrorOr(tRef.current, e, tRef.current('knowledge.cloud.err_browse', 'Could not read that folder.'));
    const where = { provider, parentId: here?.fileId, path: here?.path, driveId: here?.driveId };

    useEffect(() => {
        let alive = true;
        setState(s => ({ ...s, loading: true, error: null }));
        knowledgeApi.cloudBrowse({ provider, parentId: here?.fileId, path: here?.path, driveId: here?.driveId })
            .then((b) => { if (alive) setState({ items: b?.items || [], next: b?.nextPageToken || null, loading: false, error: null }); })
            .catch((e) => { if (alive) setState({ items: [], next: null, loading: false, error: failure(e) }); });
        return () => { alive = false; };
    }, [provider, here?.fileId, here?.path, here?.driveId]);

    const more = async () => {
        if (!state.next || moreBusy) return;
        setMoreBusy(true);
        try {
            const b = await knowledgeApi.cloudBrowse({ ...where, pageToken: state.next });
            setState(s => ({ ...s, items: [...s.items, ...(b?.items || [])], next: b?.nextPageToken || null }));
        } catch (e) {
            setState(s => ({ ...s, error: failure(e) }));
        } finally {
            setMoreBusy(false);
        }
    };
    return { state, more, moreBusy };
}

export default function CloudFolderPicker({ t, provider, onChoose }: CloudFolderPickerProps) {
    // The way down from the root; empty = the root itself.
    const [trail, setTrail] = useState<CloudItem[]>([]);
    const here = trail.length ? trail[trail.length - 1] : null;
    const { state, more, moreBusy } = useListing(t, provider, here);

    return (
        <div className="flex flex-col gap-2" data-testid="kb-cloud-picker">
            <Crumbs t={t} trail={trail} onTrail={setTrail} />
            {state.error ? (
                <p role="alert" className="text-[var(--warning-ink,var(--warning))]">{state.error}</p>
            ) : state.loading ? (
                <p className="flex items-center gap-2 text-[var(--text-tertiary)]" aria-busy="true">
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    {t('knowledge.cloud.loading', 'Reading the folder…')}
                </p>
            ) : (
                <Listing t={t} items={state.items} onOpen={(f) => setTrail([...trail, f])} />
            )}
            {state.next && !state.loading && (
                <button type="button" onClick={more} disabled={moreBusy} className="self-start text-[11px] inline-flex items-center gap-1.5 disabled:opacity-50 text-[var(--text-secondary)]">
                    {moreBusy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                    {t('knowledge.cloud.more', 'Show more')}
                </button>
            )}
            <div className="flex items-center gap-2">
                <button type="button" disabled={!here} onClick={() => here && onChoose(here)}
                    data-testid="kb-cloud-choose"
                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-50 [border-color:var(--border-default)] [color:var(--text-primary)]!">
                    {here
                        ? t('knowledge.cloud.choose_named', 'Choose “{name}”', { name: here.name })
                        : t('knowledge.cloud.choose', 'Choose this folder')}
                </button>
                {!here && (
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                        {t('knowledge.cloud.open_first', 'Open the folder first — {provider} as a whole cannot be chosen.', { provider: providerName(provider) })}
                    </span>
                )}
            </div>
        </div>
    );
}

/** Where you are: the root word, then every folder on the way down. */
function Crumbs({ t, trail, onTrail }: { t: TranslateFn; trail: CloudItem[]; onTrail: (next: CloudItem[]) => void }) {
    const atRoot = trail.length === 0;
    return (
        <nav aria-label={t('knowledge.cloud.breadcrumb', 'Folder path')} className="flex items-center gap-1 flex-wrap text-[11px] text-[var(--text-secondary)]">
            <button type="button" onClick={() => onTrail([])} aria-current={atRoot ? 'location' : undefined}
                className={`rounded underline-offset-2 hover:underline ${atRoot ? '[font-weight:600] [color:var(--text-primary)]' : ''}`}>
                {t('knowledge.cloud.root', 'All files')}
            </button>
            {trail.map((c, i) => {
                const last = i === trail.length - 1;
                return (
                    <React.Fragment key={`${c.fileId}:${i}`}>
                        <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
                        <button type="button" onClick={() => onTrail(trail.slice(0, i + 1))} aria-current={last ? 'location' : undefined}
                            className={`rounded truncate max-w-[140px] underline-offset-2 hover:underline ${last ? '[font-weight:600] [color:var(--text-primary)]' : ''}`}>
                            {c.name}
                        </button>
                    </React.Fragment>
                );
            })}
        </nav>
    );
}

/** Folders you can walk into, then the files of this folder greyed out for context. */
function Listing({ t, items, onOpen }: { t: TranslateFn; items: CloudItem[]; onOpen: (folder: CloudItem) => void }) {
    return (
        <ul role="list" aria-label={t('knowledge.cloud.list', 'Folders and files')} className="flex flex-col gap-1 max-h-56 overflow-y-auto">
            {items.length === 0 && (
                <li className="text-[var(--text-tertiary)]">{t('knowledge.cloud.empty', 'This folder is empty.')}</li>
            )}
            {items.filter(i => i.isFolder).map(f => (
                <li key={`d:${f.fileId}`}>
                    <button type="button" onClick={() => onOpen(f)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-[var(--bg-secondary)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]!">
                        <Folder className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                        <span className="truncate">{f.name}</span>
                        <ChevronRight className="w-3 h-3 ml-auto shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    </button>
                </li>
            ))}
            {items.filter(i => !i.isFolder).map(f => (
                <li key={`f:${f.fileId}`} aria-disabled="true" data-testid="kb-cloud-file"
                    className="flex items-center gap-2 px-2 py-1 opacity-50 text-[var(--text-secondary)]">
                    <FileIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{f.name}</span>
                </li>
            ))}
        </ul>
    );
}
