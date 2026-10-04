import { KeyRound, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import Modal from '../../shared/Modal';
import Toggle from '../../shared/Toggle';
import toast from '../../shared/Toast';
import useConfirm from '../../shared/useConfirm';
import { useRefreshServerMcp, useRemoveServerMcp, useToggleServerMcp } from '../../../api/queries/serverMcp';
import type { ServerMcpServer } from '../../../api/queries/serverMcp';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorText, toolCount } from '../libraryText';
import ServerLogo from '../ServerLogo';
import { ALERT_ERROR, ALERT_INFO, DANGER_BTN, EYEBROW, QUIET_BTN } from '../ui';
import ServerStatus from './ServerStatus';

/** One server-wide server, for the server administrator. */
export default function ServerAdminDrawer({ server, onClose }: { server: ServerMcpServer; onClose: () => void }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const toggle = useToggleServerMcp();
    const refresh = useRefreshServerMcp();
    const remove = useRemoveServerMcp();
    const busy = toggle.isPending || refresh.isPending || remove.isPending;
    const tools = server.tools_cache || [];
    const creds = server.required_credentials || [];
    const runs = server.transport === 'http' ? server.url : [server.command, ...(server.args || [])].filter(Boolean).join(' ');
    const err = toggle.error || refresh.error || remove.error;

    const doRemove = async () => {
        const ok = await confirm({
            title: t('mcp_library.drawer.remove_title', 'Remove {name}?', { name: server.name }),
            description: t('mcp_library.server.remove_desc', 'Every organisation loses its tools straight away.'),
            confirmLabel: t('mcp_library.drawer.remove', 'Remove'),
            destructive: true,
        });
        if (ok) remove.mutate(server.id, { onSuccess: () => { toast.success(t('mcp_library.drawer.removed', '{name} removed', { name: server.name })); onClose(); } });
    };

    return (
        <Modal
            open
            onClose={onClose}
            placement="right"
            size="md"
            title={(
                <span className="flex items-center gap-2.5 min-w-0">
                    <ServerLogo server={{ id: server.id, name: server.name, icon: server.icon }} />
                    <span className="truncate">{server.name}</span>
                </span>
            )}
            description={<ServerStatus server={server} />}
        >
            <div className="flex flex-col gap-4">
                {err && <div role="alert" className={ALERT_ERROR}>{errorText(t, err)}</div>}
                {server.status === 'error' && server.error && (
                    <div className={ALERT_ERROR}>
                        <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <span className="break-words">{server.error}</span>
                    </div>
                )}
                <Toggle
                    checked={server.enabled}
                    onChange={next => toggle.mutate({ id: server.id, enabled: next })}
                    disabled={busy}
                    size="sm"
                    label={t('mcp_library.server.enabled', 'Available to organisations')}
                    description={t('mcp_library.server.enabled_desc', 'Off removes its tools from every organisation without uninstalling it.')}
                />
                <section className="flex flex-col gap-1.5">
                    <h3 className={EYEBROW}>{server.transport === 'http' ? t('mcp_library.server.address', 'Address') : t('mcp_library.server.command', 'Command')}</h3>
                    <code className="text-[12px] text-[var(--text-primary)] break-all">{runs}</code>
                </section>
                {creds.length > 0 && (
                    <div className={ALERT_INFO}>
                        <KeyRound size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <span>{t('mcp_library.server.member_keys', 'Members add their own {labels} under Settings → Connections.', { labels: creds.map(c => c.label || c.key).join(', ') })}</span>
                    </div>
                )}
                <section className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                        <h3 className={EYEBROW}>{toolCount(t, tools.length)}</h3>
                        <button type="button" className={`${QUIET_BTN} ml-auto`} onClick={() => refresh.mutate(server.id, { onSuccess: () => toast.success(t('mcp_library.server.refreshed', 'Tools refreshed')) })} disabled={busy}>
                            <RefreshCw size={12} className={refresh.isPending ? 'animate-spin' : ''} aria-hidden="true" />
                            {t('mcp_library.server.refresh', 'Refresh tools')}
                        </button>
                    </div>
                    {tools.length > 0 ? (
                        <ul className="m-0 p-0 list-none rounded-[10px] border border-[var(--border-default)] divide-y divide-[var(--border-subtle)] max-h-[20rem] overflow-y-auto custom-scrollbar">
                            {tools.map(tl => (
                                <li key={tl.name} className="px-3 py-2">
                                    <code className="text-[12px] font-semibold text-[var(--text-primary)] break-all">{tl.name}</code>
                                    {tl.description && <span className="block mt-0.5 text-[11.5px] leading-snug text-[var(--text-tertiary)] line-clamp-2">{tl.description}</span>}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('mcp_library.server_wide.tools_later', 'Its tools appear once the first member has connected their key.')}</p>
                    )}
                </section>
                <div>
                    <button type="button" className={DANGER_BTN} onClick={doRemove} disabled={busy}>
                        <Trash2 size={13} aria-hidden="true" />{t('mcp_library.drawer.remove_button', 'Remove server')}
                    </button>
                </div>
            </div>
            {confirmDialog}
        </Modal>
    );
}
