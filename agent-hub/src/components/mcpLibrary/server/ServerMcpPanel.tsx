import { CloudOff, Globe, Plus, Server } from 'lucide-react';
import { useState } from 'react';
import { useServerMcpQuery } from '../../../api/queries/serverMcp';
import type { ServerMcpServer } from '../../../api/queries/serverMcp';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorText, toolCount } from '../libraryText';
import ServerLogo from '../ServerLogo';
import { CARD_BUTTON, CHIP, DASHED, PRIMARY_BTN, SECONDARY_BTN, SECTION_TITLE } from '../ui';
import PolicyCard from './PolicyCard';
import ServerAdminDrawer from './ServerAdminDrawer';
import ServerInstallModal from './ServerInstallModal';
import ServerStatus from './ServerStatus';

const GRID = 'grid grid-cols-1 @[34rem]/mcplib:grid-cols-2 @[60rem]/mcplib:grid-cols-3 gap-2.5';

/**
 * The server administrator's half of the MCP library: the policy for
 * organisation admins, and the servers installed for every organisation.
 */
export default function ServerMcpPanel() {
    const { t } = useTranslation();
    const query = useServerMcpQuery();
    const [installing, setInstalling] = useState(false);
    const [openId, setOpenId] = useState<string | null>(null);
    const servers = query.data ?? [];
    const open = openId ? servers.find(s => s.id === openId) || null : null;

    return (
        <div className="flex flex-col gap-5">
            <PolicyCard />

            <section className="flex flex-col gap-2.5" aria-labelledby="mcplib-server-installed">
                <div className="flex items-center gap-3">
                    <h3 id="mcplib-server-installed" className={SECTION_TITLE}>
                        <span>{t('mcp_library.server.installed', 'Installed for every organisation')}</span>
                    </h3>
                    <button type="button" className={`${PRIMARY_BTN} ml-auto`} onClick={() => setInstalling(true)}>
                        <Plus size={13} aria-hidden="true" />{t('mcp_library.server.install', 'Install a server')}
                    </button>
                </div>
                <p className="m-0 text-[12px] leading-snug text-[var(--text-tertiary)]">
                    {t('mcp_library.server.installed_hint', 'Each organisation then decides in its own library who uses them. On a plan with an integration list, add the server to the plan first.')}
                </p>

                {query.isLoading && <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('mcp_library.loading', 'Loading the MCP library…')}</p>}
                {query.isError && (
                    <div role="alert" className={DASHED}>
                        <CloudOff size={15} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <div>
                            <p className="m-0 text-[12px] text-[var(--text-secondary)]">{errorText(t, query.error)}</p>
                            <button type="button" className={`${SECONDARY_BTN} mt-2`} onClick={() => query.refetch()}>{t('mcp_library.retry', 'Try again')}</button>
                        </div>
                    </div>
                )}
                {query.isSuccess && servers.length === 0 && (
                    <div className={DASHED}>
                        <Server size={15} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <p className="m-0 text-[12px] leading-snug text-[var(--text-tertiary)]">
                            {t('mcp_library.server.empty', 'No server-wide MCP servers. Organisations can still add remote servers themselves, as far as the policy above allows.')}
                        </p>
                    </div>
                )}
                {servers.length > 0 && (
                    <div className={GRID}>
                        {servers.map(s => (
                            <button key={s.id} type="button" className={CARD_BUTTON} onClick={() => setOpenId(s.id)} aria-label={t('mcp_library.card.open', 'Open {name}', { name: s.name })}>
                                <div className="flex items-start gap-3 w-full">
                                    <ServerLogo server={{ id: s.id, name: s.name, icon: s.icon }} />
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[13px] font-semibold leading-snug text-[var(--text-primary)] truncate">{s.name}</div>
                                        <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-tertiary)] line-clamp-2">{s.description}</div>
                                    </div>
                                    <ServerStatus server={s} />
                                </div>
                                <div className="mt-auto flex flex-wrap gap-1.5 w-full">
                                    <span className={CHIP}>{toolCount(t, (s.tools_cache || []).length)}</span>
                                    <span className={CHIP}>
                                        {s.transport === 'http'
                                            ? <><Globe size={11} aria-hidden="true" />{t('mcp_library.runs_on.remote', 'Remote')}</>
                                            : <><Server size={11} aria-hidden="true" />{t('mcp_library.runs_on.server', 'Runs on this server')}</>}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </section>

            {installing && <ServerInstallModal installed={servers} onClose={() => setInstalling(false)} />}
            {open && <ServerAdminDrawer key={open.id} server={open} onClose={() => setOpenId(null)} />}
        </div>
    );
}
