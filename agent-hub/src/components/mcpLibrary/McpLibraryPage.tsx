import { CloudOff, Lock, Plug, Search, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import Tabs from '../shared/Tabs';
import { useMcpLibraryQuery } from '../../api/queries/mcpLibrary';
import type { CatalogEntry, InstalledServer, McpLibrary, ServerWideServer } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import InstallWizard from './InstallWizard';
import { CatalogCard, CustomServerCard, InstalledCard, ServerWideCard } from './LibraryCards';
import { categoryLabel, errorText, policyDescription, policyLabel } from './libraryText';
import ServerDrawer from './ServerDrawer';
import ServerWideDrawer from './ServerWideDrawer';
import ServerMcpPanel from './server/ServerMcpPanel';
import { DASHED, FILTER_CHIP_OFF, FILTER_CHIP_ON, SECONDARY_BTN, SECTION_TITLE } from './ui';

const GRID = 'grid grid-cols-1 @[34rem]/mcplib:grid-cols-2 @[60rem]/mcplib:grid-cols-3 gap-2.5';

type Wizard = { entry: CatalogEntry | null } | null;
type Open = { kind: 'org'; id: string } | { kind: 'server'; id: string } | null;

function matches(q: string, ...fields: Array<string | null | undefined>) {
    if (!q) return true;
    return fields.some(f => (f || '').toLowerCase().includes(q));
}

/**
 * Settings → Organisation → MCP library.
 *
 * One page for the three things an organisation does with MCP servers: see
 * what its agents can reach, add a server from the library (or by address
 * where the server policy allows it), and decide who uses the servers the
 * server administrator installed for everyone. A server administrator also
 * gets the "Server-wide" tab: those servers and the policy itself.
 */
export default function McpLibraryPage({ isServerAdmin: sessionServerAdmin = false }: { isServerAdmin?: boolean }) {
    const { t } = useTranslation();
    const query = useMcpLibraryQuery();
    const [tab, setTab] = useState<'org' | 'server'>('org');
    // From the session as well as from the library: a server administrator
    // without an organisation of their own gets no library (the org routes
    // answer 400) but must still reach the policy and the server-wide servers.
    // The server enforces both; this only decides what is shown.
    const isServerAdmin = sessionServerAdmin || !!query.data?.isServerAdmin;

    return (
        <div className="@container/mcplib flex flex-col gap-5">
            <header className="flex items-start gap-3">
                <span className="w-10 h-10 rounded-[10px] grid place-items-center flex-shrink-0 bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] text-[var(--accent-primary)]">
                    <Plug size={18} aria-hidden="true" />
                </span>
                <div className="flex-1 min-w-0">
                    <h2 className="m-0 text-[18px] font-semibold text-[var(--text-primary)]">{t('mcp_library.title', 'MCP library')}</h2>
                    <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">
                        {t('mcp_library.intro', 'Give your agents new tools by connecting MCP servers. Servers run at their vendor, keys stay encrypted in Bee Flow, and you decide who uses what.')}
                    </p>
                </div>
            </header>

            {isServerAdmin && (
                <Tabs
                    value={tab}
                    onChange={setTab}
                    size="sm"
                    ariaLabel={t('mcp_library.title', 'MCP library')}
                    items={[
                        { id: 'org', label: t('mcp_library.tab.org', 'Your organisation') },
                        { id: 'server', label: t('mcp_library.tab.server', 'Server-wide') },
                    ]}
                />
            )}

            {tab === 'server' && isServerAdmin
                ? <ServerMcpPanel />
                : <OrgLibrary query={query} onOpenPolicy={isServerAdmin ? () => setTab('server') : null} />}
        </div>
    );
}

function OrgLibrary({ query, onOpenPolicy }: { query: ReturnType<typeof useMcpLibraryQuery>; onOpenPolicy: (() => void) | null }) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState<string>('all');
    const [wizard, setWizard] = useState<Wizard>(null);
    const [open, setOpen] = useState<Open>(null);

    if (query.isLoading) {
        return (
            <div role="status" className={GRID}>
                {[0, 1, 2].map(i => (
                    <div key={i} className="h-[7.5rem] rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-card)] animate-pulse" />
                ))}
                <span className="sr-only">{t('mcp_library.loading', 'Loading the MCP library…')}</span>
            </div>
        );
    }
    if (query.isError || !query.data) {
        const locked = query.error?.code === 'feature_locked';
        return (
            <div role="alert" className={DASHED}>
                {locked ? <Lock size={15} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" /> : <CloudOff size={15} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />}
                <div className="min-w-0">
                    <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                        {locked ? t('mcp_library.locked_title', 'The MCP library is not part of your plan') : t('mcp_library.load_failed', 'The MCP library could not be loaded')}
                    </div>
                    <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">
                        {locked ? t('mcp_library.locked_desc', 'Ask your administrator about the Enterprise plan.') : errorText(t, query.error)}
                    </p>
                    {!locked && (
                        <button type="button" className={`${SECONDARY_BTN} mt-2`} onClick={() => query.refetch()} disabled={query.isFetching}>
                            {t('mcp_library.retry', 'Try again')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    const data: McpLibrary = query.data;
    const q = search.trim().toLowerCase();
    const catalogById = new Map(data.catalog.map(e => [e.id, e]));
    const installed = data.installed.filter(s => matches(q, s.name, s.host, s.description));
    const serverWideInUse = data.serverWide.filter(s => s.access.mode !== 'nobody' && matches(q, s.name, s.description));
    const serverWideIdle = data.serverWide.filter(s => s.access.mode === 'nobody' && matches(q, s.name, s.description));
    const categories = [...new Set(data.catalog.map(e => e.category))];
    const catalog = data.catalog.filter(e => (category === 'all' || e.category === category) && matches(q, e.name, e.description, e.host));
    const policy = data.policy;

    const lockedReason = (e: CatalogEntry): string | null => {
        if (e.allowed) return null;
        if (policy.remote === 'off') return t('mcp_library.locked.off', 'Your server administrator has switched off adding MCP servers.');
        return t('mcp_library.locked.self_hosted', 'Your own instances need your server administrator to allow custom addresses.');
    };

    const openOrg = open?.kind === 'org' ? data.installed.find(s => s.id === open.id) || null : null;
    const openServer = open?.kind === 'server' ? data.serverWide.find(s => s.id === open.id) || null : null;
    const nothingInUse = data.installed.length === 0 && data.serverWide.every(s => s.access.mode === 'nobody');

    return (
        <>
            <div className="flex flex-wrap items-start gap-3 px-3.5 py-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)]">
                <ShieldCheck size={16} className="mt-0.5 flex-shrink-0 text-[var(--success)]" aria-hidden="true" />
                <div className="flex-1 min-w-[12rem]">
                    <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                        {t('mcp_library.policy.line', 'Server policy: {policy}', { policy: policyLabel(t, policy.remote) })}
                    </div>
                    <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">{policyDescription(t, policy.remote)}</p>
                </div>
                {onOpenPolicy && (
                    <button type="button" className={SECONDARY_BTN} onClick={onOpenPolicy}>{t('mcp_library.policy.change', 'Change policy')}</button>
                )}
            </div>

            <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg @[56rem]/mcplib:w-96 border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] text-[var(--text-tertiary)] focus-within:border-[var(--accent-primary)]">
                <Search size={13} aria-hidden="true" />
                <input
                    type="search"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={t('mcp_library.search', 'Search servers…')}
                    aria-label={t('mcp_library.search_label', 'Search servers')}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
                {search && (
                    <button type="button" onClick={() => setSearch('')} aria-label={t('mcp_library.tools.clear_search', 'Clear the search')} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                        <X size={12} />
                    </button>
                )}
            </label>

            <section className="flex flex-col gap-2.5" aria-labelledby="mcplib-in-use">
                <h3 id="mcplib-in-use" className={SECTION_TITLE}>
                    <span>{t('mcp_library.section.in_use', 'In your organisation')}</span>
                </h3>
                {nothingInUse ? (
                    <div className={DASHED}>
                        <Plug size={15} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <div className="min-w-0">
                            <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t('mcp_library.empty_title', 'No MCP servers yet')}</div>
                            <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">{t('mcp_library.empty_desc', 'Add one below. It takes a minute: pick a server, paste a key if it needs one, choose its tools.')}</p>
                        </div>
                    </div>
                ) : (installed.length + serverWideInUse.length === 0 ? (
                    <NoMatch onClear={() => setSearch('')} />
                ) : (
                    <div className={GRID}>
                        {installed.map((s: InstalledServer) => (
                            <InstalledCard key={s.id} server={s} catalog={s.catalogId ? catalogById.get(s.catalogId) : null} onOpen={() => setOpen({ kind: 'org', id: s.id })} />
                        ))}
                        {serverWideInUse.map((s: ServerWideServer) => (
                            <ServerWideCard key={s.id} server={s} onOpen={() => setOpen({ kind: 'server', id: s.id })} />
                        ))}
                    </div>
                ))}
            </section>

            {serverWideIdle.length > 0 && (
                <section className="flex flex-col gap-2.5" aria-labelledby="mcplib-server-wide">
                    <h3 id="mcplib-server-wide" className={SECTION_TITLE}>
                        <span>{t('mcp_library.section.server_wide', 'From your server administrator')}</span>
                        <span className="text-[11px] font-normal text-[var(--text-tertiary)]">{t('mcp_library.section.server_wide_hint', 'Switch them on for your organisation')}</span>
                    </h3>
                    <div className={GRID}>
                        {serverWideIdle.map(s => (
                            <ServerWideCard key={s.id} server={s} onOpen={() => setOpen({ kind: 'server', id: s.id })} />
                        ))}
                    </div>
                </section>
            )}

            <section className="flex flex-col gap-2.5" aria-labelledby="mcplib-add">
                <h3 id="mcplib-add" className={SECTION_TITLE}>
                    <span>{t('mcp_library.section.add', 'Add a server')}</span>
                </h3>
                {categories.length > 1 && (
                    <div role="group" aria-label={t('mcp_library.categories', 'Categories')} className="flex flex-wrap gap-1.5">
                        <button type="button" aria-pressed={category === 'all'} className={category === 'all' ? FILTER_CHIP_ON : FILTER_CHIP_OFF} onClick={() => setCategory('all')}>
                            {t('mcp_library.category.all', 'All')}
                        </button>
                        {categories.map(c => (
                            <button key={c} type="button" aria-pressed={category === c} className={category === c ? FILTER_CHIP_ON : FILTER_CHIP_OFF} onClick={() => setCategory(c)}>
                                {categoryLabel(t, c)}
                            </button>
                        ))}
                    </div>
                )}
                {catalog.length === 0 && (q || category !== 'all') ? (
                    <NoMatch onClear={() => { setSearch(''); setCategory('all'); }} />
                ) : (
                    <div className={GRID}>
                        {catalog.map(e => (
                            <CatalogCard key={e.id} entry={e} lockedReason={lockedReason(e)} onAdd={() => setWizard({ entry: e })} />
                        ))}
                        {policy.allowsCustomUrls && <CustomServerCard onAdd={() => setWizard({ entry: null })} />}
                    </div>
                )}
                {!policy.allowsCustomUrls && policy.remote !== 'off' && (
                    <p className="m-0 text-[11.5px] leading-snug text-[var(--text-tertiary)]">
                        {t('mcp_library.custom.not_allowed', 'Need a server that is not listed? Your server administrator can allow other addresses.')}
                    </p>
                )}
            </section>

            {wizard && (
                <InstallWizard
                    entry={wizard.entry}
                    groups={data.groups}
                    onClose={() => setWizard(null)}
                    onOpenInstalled={(server) => { setWizard(null); setOpen({ kind: 'org', id: server.id }); }}
                />
            )}
            {openOrg && (
                <ServerDrawer
                    key={openOrg.id}
                    server={openOrg}
                    catalog={openOrg.catalogId ? catalogById.get(openOrg.catalogId) || null : null}
                    groups={data.groups}
                    onClose={() => setOpen(null)}
                />
            )}
            {openServer && (
                <ServerWideDrawer key={openServer.id} server={openServer} groups={data.groups} onClose={() => setOpen(null)} />
            )}
        </>
    );
}

function NoMatch({ onClear }: { onClear: () => void }) {
    const { t } = useTranslation();
    return (
        <p className="m-0 text-[12px] text-[var(--text-secondary)]">
            {t('mcp_library.no_match', 'No server matches.')}{' '}
            <button type="button" className="underline text-[var(--text-primary)]" onClick={onClear}>
                {t('mcp_library.clear_filters', 'Clear the filters')}
            </button>
        </p>
    );
}
