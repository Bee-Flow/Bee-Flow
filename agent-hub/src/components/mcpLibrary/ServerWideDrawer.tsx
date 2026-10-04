import { Globe, KeyRound, Lock, Server } from 'lucide-react';
import { useState } from 'react';
import Modal from '../shared/Modal';
import toast from '../shared/Toast';
import { useSetServerWideAccess } from '../../api/queries/mcpLibrary';
import type { ServerWideServer } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import AccessPicker from './AccessPicker';
import type { AccessValue } from './AccessPicker';
import { errorText, toolCount } from './libraryText';
import ServerLogo from './ServerLogo';
import { ALERT_ERROR, ALERT_INFO, EYEBROW, PRIMARY_BTN } from './ui';

interface ServerWideDrawerProps {
    server: ServerWideServer;
    groups: Array<{ id: string; name: string }>;
    onClose: () => void;
}

/**
 * A server the server administrator installed for every organisation. An
 * organisation admin cannot change it, only decide who in their organisation
 * uses it.
 */
export default function ServerWideDrawer({ server, groups, onClose }: ServerWideDrawerProps) {
    const { t } = useTranslation();
    const save = useSetServerWideAccess();
    const [access, setAccess] = useState<AccessValue>(server.access);
    const dirty = access.mode !== server.access.mode || access.groupIds.join(',') !== server.access.groupIds.join(',');
    const ready = access.mode !== 'groups' || access.groupIds.length > 0;

    const submit = () => save.mutate({
        serverId: server.id,
        access: access.mode === 'groups' ? { mode: 'groups', groupIds: access.groupIds } : { mode: access.mode },
    }, { onSuccess: () => { toast.success(t('mcp_library.drawer.access_saved', 'Access saved')); onClose(); } });

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
            description={t('mcp_library.server_wide.from_admin', 'Installed by your server administrator')}
            footer={server.available ? (
                <button type="button" className={PRIMARY_BTN} onClick={submit} disabled={!dirty || !ready || save.isPending}>
                    {t('mcp_library.drawer.save_access', 'Save access')}
                </button>
            ) : undefined}
        >
            <div className="flex flex-col gap-4">
                {server.description && <p className="m-0 text-[12.5px] leading-snug text-[var(--text-secondary)]">{server.description}</p>}
                <div className={ALERT_INFO}>
                    {server.runsOn === 'server'
                        ? <Server size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                        : <Globe size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />}
                    <span>
                        {server.runsOn === 'server'
                            ? t('mcp_library.server_wide.runs_here', 'Runs on this Bee Flow server, managed by your server administrator.')
                            : t('mcp_library.server_wide.runs_remote', 'Runs at the vendor, connected by your server administrator.')}
                    </span>
                </div>
                {server.credentials.length > 0 && (
                    <p className="m-0 flex items-start gap-1.5 text-[12px] leading-snug text-[var(--text-secondary)]">
                        <KeyRound size={13} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        {t('mcp_library.server_wide.keys', 'Each member adds their own {labels} under Settings → Connections.', { labels: server.credentials.join(', ') })}
                    </p>
                )}

                {server.available ? (
                    <section className="flex flex-col gap-2">
                        <h3 className={EYEBROW}>{t('mcp_library.access.label', 'Who can use it')}</h3>
                        <AccessPicker value={access} onChange={setAccess} groups={groups} allowNobody disabled={save.isPending} />
                    </section>
                ) : (
                    <div className={ALERT_INFO}>
                        <Lock size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <span>{t('mcp_library.server_wide.not_in_plan', 'Your organisation\'s plan does not include this server. Ask your server administrator to add it.')}</span>
                    </div>
                )}
                {save.isError && <div role="alert" className={ALERT_ERROR}>{errorText(t, save.error)}</div>}

                <section className="flex flex-col gap-2">
                    <h3 className={EYEBROW}>{toolCount(t, server.toolCount)}</h3>
                    {server.tools.length > 0 ? (
                        <ul className="m-0 p-0 list-none rounded-[10px] border border-[var(--border-default)] divide-y divide-[var(--border-subtle)] max-h-[18rem] overflow-y-auto custom-scrollbar">
                            {server.tools.map(tl => (
                                <li key={tl.name} className="px-3 py-2">
                                    <code className="text-[12px] font-semibold text-[var(--text-primary)] break-all">{tl.name}</code>
                                    {tl.description && <span className="block mt-0.5 text-[11.5px] leading-snug text-[var(--text-tertiary)] line-clamp-2">{tl.description}</span>}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="m-0 text-[12px] text-[var(--text-tertiary)]">
                            {t('mcp_library.server_wide.tools_later', 'Its tools appear once the first member has connected their key.')}
                        </p>
                    )}
                </section>
            </div>
        </Modal>
    );
}
