import { useInfiniteQuery } from '@tanstack/react-query';
import { Search, ShieldAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import Modal from '../../shared/Modal';
import Tabs from '../../shared/Tabs';
import toast from '../../shared/Toast';
import useConfirm from '../../shared/useConfirm';
import { searchMcpRegistry, serverMcpKeys, useInstallServerMcp } from '../../../api/queries/serverMcp';
import type { ServerMcpCandidate, ServerMcpInstall, ServerMcpServer } from '../../../api/queries/serverMcp';
import { CATEGORIES, MCP_REGISTRY } from '../../../config/mcpCatalog';
import { useTranslation } from '../../../hooks/useTranslation';
import { bestLogoUrl } from '../../../utils/mcpLogos';
import { errorText } from '../libraryText';
import { ALERT_ERROR, ALERT_WARNING, FILTER_CHIP_OFF, FILTER_CHIP_ON, SECONDARY_BTN } from '../ui';
import CandidateRow from './CandidateRow';
import CustomServerForm from './CustomServerForm';

// Same derivation as the server (routes/ai/config/integrations.js: name → id),
// so a card can be matched against what is installed before it has an id.
const slugify = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

type Source = 'library' | 'registry' | 'custom';
const LIST = 'm-0 p-0 list-none rounded-[10px] border border-[var(--border-default)] divide-y divide-[var(--border-subtle)]';

/** Install a server for every organisation: from the curated library, the open MCP registry, or by hand. */
export default function ServerInstallModal({ installed, onClose }: { installed: ServerMcpServer[]; onClose: () => void }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const install = useInstallServerMcp();
    const [source, setSource] = useState<Source>('library');
    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [category, setCategory] = useState('all');
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const installedIds = useMemo(() => new Set(installed.map(s => s.id)), [installed]);

    useEffect(() => {
        const h = setTimeout(() => setDebounced(search.trim()), 350);
        return () => clearTimeout(h);
    }, [search]);

    const registry = useInfiniteQuery({
        queryKey: serverMcpKeys.registry(debounced),
        queryFn: ({ pageParam, signal }) => searchMcpRegistry(debounced, pageParam, signal),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor,
        enabled: source === 'registry',
        retry: false,
    });

    const library = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (MCP_REGISTRY as ServerMcpCandidate[]).filter(s => (category === 'all' || s.category === category)
            && (!q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)));
    }, [search, category]);

    const isInstalled = (c: ServerMcpCandidate) => installedIds.has(c.id || slugify(c.name)) || installedIds.has(slugify(c.name));

    const doInstall = async (c: ServerMcpCandidate, url?: string, trusted = true) => {
        const key = c.id || slugify(c.name);
        const local = c.transport !== 'http';
        if (local && !trusted) {
            const ok = await confirm({
                title: t('mcp_library.server.run_confirm_title', 'Run this program on your server?'),
                description: t('mcp_library.server.run_confirm_desc', 'Installing downloads and starts "{command}" on this Bee Flow server, with network access. Only install software you trust.', { command: [c.command, ...(c.args || [])].filter(Boolean).join(' ') }),
                confirmLabel: t('mcp_library.server.run_confirm', 'Install and run'),
                destructive: true,
            });
            if (!ok) return;
        }
        if (!c.id && installedIds.has(key)) {
            const ok = await confirm({
                title: t('mcp_library.server.overwrite_title', 'A server named "{name}" is already installed', { name: c.name }),
                description: t('mcp_library.server.overwrite_desc', 'Replace its configuration?'),
                confirmLabel: t('mcp_library.server.overwrite', 'Replace'),
                destructive: true,
            });
            if (!ok) return;
        }
        const input: ServerMcpInstall = {
            name: c.name,
            command: c.command || undefined,
            args: c.args || [],
            transport: c.transport === 'http' ? 'http' : 'stdio',
            url: url ?? (c.url || null),
            category: c.category,
            description: c.description,
            icon: (bestLogoUrl(c) as string | null) || c.icon || undefined,
            required_credentials: c.required_credentials || [],
            source: c.source || (source === 'registry' ? 'registry' : 'manual'),
        };
        setBusyKey(key);
        install.mutate(input, {
            onSuccess: (srv) => toast.success(t('mcp_library.server.installed_toast', '{name} installed for every organisation', { name: srv.name || c.name })),
            onSettled: () => setBusyKey(null),
        });
    };

    const registryRows = registry.data?.pages.flatMap(p => p.servers) ?? [];

    return (
        <Modal open onClose={onClose} size="xl" title={t('mcp_library.server.install_title', 'Install a server for every organisation')}
            description={t('mcp_library.server.install_desc', 'Organisations decide in their own library who uses it.')}>
            <div className="flex flex-col gap-3">
                <div className={ALERT_WARNING}>
                    <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span>{t('mcp_library.server.local_warning', 'A server that runs on this server is a program Bee Flow downloads and starts here. It gets no secrets beyond its own keys, but it does get network access. Prefer remote servers, and pinned versions of software you trust.')}</span>
                </div>
                <Tabs
                    value={source}
                    onChange={setSource}
                    size="sm"
                    ariaLabel={t('mcp_library.server.source', 'Source')}
                    items={[
                        { id: 'library', label: t('mcp_library.server.source_library', 'Library') },
                        { id: 'registry', label: t('mcp_library.server.source_registry', 'MCP registry') },
                        { id: 'custom', label: t('mcp_library.server.source_custom', 'Custom') },
                    ]}
                />
                {source !== 'custom' && (
                    <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] text-[var(--text-tertiary)] focus-within:border-[var(--accent-primary)]">
                        <Search size={13} aria-hidden="true" />
                        <input type="search" value={search} onChange={e => setSearch(e.target.value)}
                            placeholder={source === 'registry' ? t('mcp_library.server.search_registry', 'Search the open MCP registry…') : t('mcp_library.search', 'Search servers…')}
                            aria-label={t('mcp_library.search_label', 'Search servers')}
                            className="flex-1 min-w-0 bg-transparent outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]" />
                        {search && <button type="button" onClick={() => setSearch('')} aria-label={t('mcp_library.tools.clear_search', 'Clear the search')} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X size={12} /></button>}
                    </label>
                )}
                {install.isError && <div role="alert" className={ALERT_ERROR}>{errorText(t, install.error)}</div>}

                {source === 'library' && (
                    <>
                        <div role="group" aria-label={t('mcp_library.categories', 'Categories')} className="flex flex-wrap gap-1.5">
                            {CATEGORIES.map((c: { id: string; label: string }) => (
                                <button key={c.id} type="button" aria-pressed={category === c.id} className={category === c.id ? FILTER_CHIP_ON : FILTER_CHIP_OFF} onClick={() => setCategory(c.id)}>
                                    {c.id === 'all' ? t('mcp_library.category.all', 'All') : c.label}
                                </button>
                            ))}
                        </div>
                        <ul className={LIST}>
                            {library.map(c => (
                                <CandidateRow key={c.id || c.name} candidate={c} installed={isInstalled(c)} busy={busyKey === (c.id || slugify(c.name))}
                                    disabled={!!busyKey} onInstall={(cand, url) => doInstall(cand, url, true)} />
                            ))}
                        </ul>
                        {library.length === 0 && <p className="m-0 text-[12px] text-[var(--text-secondary)]">{t('mcp_library.no_match', 'No server matches.')}</p>}
                    </>
                )}

                {source === 'registry' && (
                    <>
                        <p className="m-0 text-[11.5px] text-[var(--text-tertiary)]">{t('mcp_library.server.registry_hint', 'Live from registry.modelcontextprotocol.io, active and latest versions only. These are not reviewed by Bee Flow.')}</p>
                        {registry.isError && <div role="alert" className={ALERT_ERROR}>{errorText(t, registry.error)}</div>}
                        {registryRows.length > 0 && (
                            <ul className={LIST}>
                                {registryRows.map((c, i) => (
                                    <CandidateRow key={`${c.name}-${i}`} candidate={c} installed={isInstalled(c)} busy={busyKey === slugify(c.name)}
                                        disabled={!!busyKey} onInstall={(cand, url) => doInstall(cand, url, false)} />
                                ))}
                            </ul>
                        )}
                        {registry.isFetching && <p role="status" className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('mcp_library.server.searching', 'Searching…')}</p>}
                        {registry.isSuccess && registryRows.length === 0 && !registry.isFetching && <p className="m-0 text-[12px] text-[var(--text-secondary)]">{t('mcp_library.no_match', 'No server matches.')}</p>}
                        {registry.hasNextPage && !registry.isFetching && (
                            <div><button type="button" className={SECONDARY_BTN} onClick={() => registry.fetchNextPage()}>{t('mcp_library.server.load_more', 'Load more')}</button></div>
                        )}
                    </>
                )}

                {source === 'custom' && <CustomServerForm busy={install.isPending} onInstall={(input) => doInstall({ ...input }, undefined, false)} />}
            </div>
            {confirmDialog}
        </Modal>
    );
}
