import { ChevronRight, FileSpreadsheet, Folder, Link2, Loader2, RefreshCw, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { formatLabel, providerLogoId, providerName, ssErrorMessage } from '../datatableDisplay';
import { datatablesApi } from '../datatablesApi';
import { CARD, INPUT, INPUT_STYLE } from '../linkWizardShared';
import { fileKeyOf, filesSelectedIn, isProviderError, ssReasonText } from './wizardState';
import useDebouncedValue from '../../../../../hooks/useDebouncedValue';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import { getIntegrationLogo } from '../../../../../utils/integrationLogos';
import Tabs from '../../../../shared/Tabs';

/**
 * Step 1 of the link-spreadsheet wizard: which files?
 *
 * One storage at a time (a tab per connected storage), one folder at a
 * time (a breadcrumb), spreadsheet files as checkboxes and folders as
 * buttons. The selection is GLOBAL — across folders and across storages —
 * and lives in the dialog; what lives here is only where the person is
 * looking. So a file ticked in "Finance" stays ticked after wandering off
 * to OneDrive, and the summary under the list is the one place the whole
 * selection can be read and undone.
 *
 * NEW UI rather than a reuse: the chat's Google Drive picker lists only
 * Docs/Sheets/Slides through its own route, and the Nextcloud scope tree
 * is folders-only. Neither can show an .xlsx in a folder, let alone in
 * three storages behind one id parameter.
 *
 * ── ONE `folderId`, THREE STORAGES ──────────────────────────────────
 * The server hides what an id is: `'root'`, `'shared'` (the shared-with-me
 * root of Drive and OneDrive) or whatever it handed out in a listing — for
 * Nextcloud the id IS the path. This component never reads one; it hands
 * back what it was given. A non-empty search browses `'root'` with `q`
 * and the breadcrumb collapses to "Search results".
 *
 * Plain tab stops: folder buttons, checkboxes and crumbs are ordinary
 * focusable controls. A roving-focus list is on the follow-up list, not
 * here — Tab works everywhere, and a half-finished arrow-key scheme is
 * worse than none.
 */
export default function FileBrowser({ t, scope, providers, files, onToggle, marks }) {
    const rel = useRelativeTime();
    const connected = useMemo(() => providers.filter(p => p.connected), [providers]);
    const [provider, setProvider] = useState(() => (connected[0] || providers[0] || {}).provider || null);
    const [folderId, setFolderId] = useState('root');
    const [shared, setShared] = useState(false);
    const [q, setQ] = useState('');
    const dq = useDebouncedValue(q.trim(), 300);
    const [tick, setTick] = useState(0);
    const [page, setPage] = useState({ folder: null, items: [], nextPageToken: null, loading: true, error: null });
    const [moreBusy, setMoreBusy] = useState(false);
    const current = providers.find(p => p.provider === provider) || null;
    const searching = dq.length > 0;
    // Typing (or a folder click that clears the box) is in flight until the
    // debounce settles; reading the folder in between would read it twice.
    const typing = q.trim() !== dq;

    // Read the folder whenever where-we-look changes. `alive` drops an
    // answer that arrives after the person has moved on — a slow "Finance"
    // must not overwrite a fast "Shared with me".
    useEffect(() => {
        if (!provider || !current?.connected || typing) return undefined;
        let alive = true;
        setPage(p => ({ ...p, loading: true, error: null }));
        datatablesApi.browseSpreadsheets({ provider, folderId: searching ? 'root' : folderId, q: searching ? dq : null, shared, pageToken: null, scope })
            .then((b) => { if (alive) setPage({ folder: b?.folder || null, items: b?.items || [], nextPageToken: b?.nextPageToken || null, loading: false, error: null }); })
            .catch((e) => { if (alive) setPage({ folder: null, items: [], nextPageToken: null, loading: false, error: e }); });
        return () => { alive = false; };
    }, [provider, folderId, dq, searching, typing, shared, scope, tick, current?.connected]);

    const more = async () => {
        if (!page.nextPageToken || moreBusy) return;
        setMoreBusy(true);
        try {
            const b = await datatablesApi.browseSpreadsheets({ provider, folderId: searching ? 'root' : folderId, q: searching ? dq : null, shared, pageToken: page.nextPageToken, scope });
            setPage(p => ({ ...p, items: [...p.items, ...(b?.items || [])], nextPageToken: b?.nextPageToken || null }));
        } catch (e) {
            setPage(p => ({ ...p, error: e }));
        } finally {
            setMoreBusy(false);
        }
    };

    const switchProvider = (id) => { setProvider(id); setFolderId('root'); setShared(false); setQ(''); };
    const toggleShared = (on) => { setShared(on); setFolderId(on ? 'shared' : 'root'); setQ(''); };
    const openFolder = (id) => { setFolderId(id); setQ(''); };

    const tabs = providers.map(p => {
        const Logo = getIntegrationLogo(providerLogoId(p.provider));
        const n = filesSelectedIn(files, p.provider);
        return {
            id: p.provider, label: providerName(p.provider), disabled: !p.connected,
            icon: Logo ? <span className="inline-flex" aria-hidden="true">{React.createElement(Logo, { size: 14 })}</span> : null,
            badge: n > 0 ? n : undefined,
        };
    });
    const selected = [...files.values()];

    return (
        <div className="space-y-3">
            {providers.length > 1 && (
                <Tabs size="sm" ariaLabel={t('datatables.ss_providers', 'Storage')} value={provider || ''} onChange={switchProvider} items={tabs} />
            )}
            {/* A storage that is off cannot be switched to, so its reason is
                said here, under the strip, for every one that is off. */}
            {providers.filter(p => !p.connected).map(p => (
                <p key={p.provider} className="text-xs" style={{ color: 'var(--text-secondary)' }}>{ssReasonText(t, p)}</p>
            ))}
            {current?.connected && (
                <>
                    <div className="flex items-center gap-2 flex-wrap">
                        <Breadcrumb t={t} shared={shared} searching={searching} folderId={folderId} folder={page.folder} onOpen={openFolder} />
                        <span className="ml-auto" />
                        {provider !== 'nextcloud_files' && (
                            <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                                <input type="checkbox" checked={shared} onChange={(e) => toggleShared(e.target.checked)} />
                                {t('datatables.ss_shared_toggle', 'Shared with me')}
                            </label>
                        )}
                        <button type="button" onClick={() => setTick(x => x + 1)} aria-label={t('datatables.ss_refresh', 'Read the folder again')}
                            className="p-1 rounded focus-visible:outline focus-visible:outline-2" style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    <label className="relative block">
                        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('datatables.ss_search', 'Find a spreadsheet')}
                            aria-label={t('datatables.ss_search', 'Find a spreadsheet')} className={`${INPUT} pl-9`} style={INPUT_STYLE} />
                    </label>
                    <Listing t={t} page={page} provider={provider} searching={searching} q={dq} rel={rel} files={files} marks={marks}
                        onOpen={openFolder} onToggle={(item) => onToggle({ ...item, provider })} onMore={more} moreBusy={moreBusy} />
                </>
            )}
            {selected.length > 0 && (
                <div className="space-y-1.5">
                    <span className="block text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {selected.length === 1
                            ? t('datatables.ss_selected_one', '1 file selected')
                            : t('datatables.ss_selected_n', '{n} files selected', { n: selected.length })}
                    </span>
                    <ul className="flex flex-wrap gap-1.5" role="list">
                        {selected.map((f) => (
                            <li key={fileKeyOf(f.provider, f.id)} className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full"
                                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                                <span className="truncate max-w-[220px]">{f.name}</span>
                                <span style={{ color: 'var(--text-tertiary)' }}>· {providerName(f.provider)}</span>
                                <button type="button" onClick={() => onToggle(f)} aria-label={t('datatables.ss_unselect', 'Unselect {name}', { name: f.name })}
                                    className="p-0.5 rounded" style={{ color: 'var(--text-tertiary)' }}>
                                    <X className="w-3 h-3" aria-hidden="true" />
                                </button>
                            </li>
                        ))}
                    </ul>
                    {selected.filter(f => marks.get(fileKeyOf(f.provider, f.id))).map(f => (
                        <p key={fileKeyOf(f.provider, f.id)} className="text-[11px]" style={{ color: 'var(--warning)' }}>{f.name}: {marks.get(fileKeyOf(f.provider, f.id))}</p>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Where you are: the root word, then every folder on the way; a search collapses it to one word. */
function Breadcrumb({ t, shared, searching, folderId, folder, onOpen }) {
    const rootId = shared ? 'shared' : 'root';
    const rootLabel = shared ? t('datatables.ss_shared_root', 'Shared with me') : t('datatables.ss_root', 'All files');
    // The server's `path` is the chain of folders down to here; when it stops
    // short of the current folder, the current one is appended so the last
    // crumb is always where the listing is.
    const path = folder ? [...(folder.path || [])] : [];
    if (folder && folder.id && folder.id !== rootId && folder.id !== 'root' && folder.id !== 'shared' && !path.some(p => p.id === folder.id)) {
        path.push({ id: folder.id, name: folder.name });
    }
    const crumbs = searching ? [] : path;
    const atRoot = !searching && folderId === rootId;
    return (
        <nav aria-label={t('datatables.ss_breadcrumb', 'Folder path')} className="flex items-center gap-1 text-xs min-w-0 flex-wrap" style={{ color: 'var(--text-secondary)' }}>
            <button type="button" onClick={() => onOpen(rootId)} className="rounded underline-offset-2 hover:underline" aria-current={atRoot ? 'location' : undefined}
                style={{ color: atRoot ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: atRoot ? 600 : 400 }}>
                {rootLabel}
            </button>
            {searching && (
                <>
                    <ChevronRight className="w-3 h-3" aria-hidden="true" />
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t('datatables.ss_search_results', 'Search results')}</span>
                </>
            )}
            {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                    <React.Fragment key={`${c.id}:${i}`}>
                        <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
                        <button type="button" onClick={() => onOpen(c.id)} className="rounded truncate max-w-[160px] underline-offset-2 hover:underline" aria-current={last ? 'location' : undefined}
                            style={{ color: last ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: last ? 600 : 400 }}>
                            {c.name}
                        </button>
                    </React.Fragment>
                );
            })}
        </nav>
    );
}

function Listing({ t, page, provider, searching, q, rel, files, marks, onOpen, onToggle, onMore, moreBusy }) {
    if (page.error) {
        const e = page.error;
        return (
            <p role="alert" className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-primary)', color: 'var(--warning)' }}>
                {ssErrorMessage(t, e, providerName(provider)) || e.message}
                {isProviderError(e) && <> {t('datatables.ss_connect_hint', 'Connect it under Settings → Connections.')}</>}
            </p>
        );
    }
    if (page.loading) {
        return (
            <p className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }} aria-busy="true">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />{t('datatables.ss_loading', 'Reading the folder…')}
            </p>
        );
    }
    if (page.items.length === 0) {
        return (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {searching ? t('datatables.ss_empty_search', 'Nothing found for “{q}”.', { q }) : t('datatables.ss_empty_folder', 'No spreadsheets in this folder.')}
            </p>
        );
    }
    return (
        <div className="space-y-1.5">
            <ul className="space-y-1.5" role="list" aria-label={t('datatables.ss_files_list', 'Files and folders')}>
                {page.items.map((item) => (
                    <li key={`${item.kind}:${item.id}`}>
                        {item.kind === 'folder'
                            ? <FolderRow item={item} rel={rel} onOpen={onOpen} />
                            : <FileRow t={t} item={item} provider={provider} rel={rel} checked={files.has(fileKeyOf(provider, item.id))} mark={marks.get(fileKeyOf(provider, item.id))} onToggle={onToggle} />}
                    </li>
                ))}
            </ul>
            {page.nextPageToken && (
                <button type="button" onClick={onMore} disabled={moreBusy} className="text-xs inline-flex items-center gap-1.5 rounded disabled:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                    {moreBusy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                    {t('datatables.ss_more', 'Show more')}
                </button>
            )}
        </div>
    );
}

function FolderRow({ item, rel, onOpen }) {
    return (
        <button type="button" onClick={() => onOpen(item.id)} className="w-full flex items-center gap-3 p-2.5 text-left focus-visible:outline focus-visible:outline-2" style={{ ...CARD, outlineColor: 'var(--accent-primary)' }}>
            <Folder className="w-4 h-4 shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
            <span className="text-sm font-medium truncate min-w-0" style={{ color: 'var(--text-primary)' }}>{item.name}</span>
            {item.modifiedAt && <span className="ml-auto text-[11px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>{rel(item.modifiedAt)}</span>}
            <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)', marginLeft: item.modifiedAt ? 0 : 'auto' }} aria-hidden="true" />
        </button>
    );
}

/**
 * A file with a linked sheet stays tickable: the listing does not know how
 * many sheets a workbook has, so a second sheet may well be free. A csv is
 * the exception — it IS one sheet, so "1 sheet linked" means there is
 * nothing left to link and the sheets step would be a dead end. It is
 * disabled here, unless it is already ticked (so it can still be unticked).
 */
function isDeadEnd(item, linked, checked) {
    return item.format === 'csv' && linked > 0 && !checked;
}

function FileRow({ t, item, provider, rel, checked, mark, onToggle }) {
    const SheetsLogo = item.format === 'gsheet' ? getIntegrationLogo('google_sheets') : null;
    const linked = Array.isArray(item.linkedAs) ? item.linkedAs.length : 0;
    const dead = isDeadEnd(item, linked, checked);
    const meta = item.modifiedAt
        ? t('datatables.ss_file_meta', '{format} · changed {when}', { format: formatLabel(t, item.format), when: rel(item.modifiedAt) })
        : formatLabel(t, item.format);
    return (
        <label className={`flex items-start gap-3 p-2.5 ${dead ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            style={{ ...CARD, borderColor: checked ? 'var(--accent-primary)' : 'var(--border-default)', opacity: dead ? 0.6 : 1 }}>
            <input type="checkbox" checked={checked} disabled={dead} onChange={() => onToggle(item)} className="mt-0.5 shrink-0" aria-label={item.name} />
            {SheetsLogo
                ? <span className="mt-0.5 shrink-0 inline-flex" data-testid="logo-google_sheets" aria-hidden="true">{React.createElement(SheetsLogo, { size: 16 })}</span>
                : <FileSpreadsheet className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--type-data)' }} aria-hidden="true" />}
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</span>
                    {item.format && (
                        <span className="text-[10px] uppercase px-1.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{item.format}</span>
                    )}
                    {linked > 0 && (
                        <span className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                            <Link2 className="w-3 h-3" aria-hidden="true" />
                            {linked === 1 ? t('datatables.ss_linked_chip_one', '1 sheet linked') : t('datatables.ss_linked_chip', '{n} sheets linked', { n: linked })}
                        </span>
                    )}
                </span>
                <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {meta}{item.path && provider === 'nextcloud_files' ? ` · ${item.path}` : ''}
                </span>
                {mark && <span className="block text-[11px] mt-1" style={{ color: 'var(--warning)' }}>{mark}</span>}
            </span>
        </label>
    );
}
