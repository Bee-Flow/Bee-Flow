import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import toast from '../../components/shared/Toast';
import { useDeleteMyMcpKey, useMyMcpServersQuery, useSaveMyMcpKey } from '../../api/queries/mcpLibrary';
import type { MemberServer } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import { errorText } from '../../components/mcpLibrary/libraryText';
import ServerLogo from '../../components/mcpLibrary/ServerLogo';
import { ALERT_ERROR, CHIP, CHIP_SUCCESS, HINT, INPUT, PRIMARY_BTN, QUIET_BTN } from '../../components/mcpLibrary/ui';

function ServerKeyRow({ server }: { server: MemberServer }) {
    const { t } = useTranslation();
    const inputId = useId();
    const save = useSaveMyMcpKey();
    const remove = useDeleteMyMcpKey();
    const [open, setOpen] = useState(!server.connected && !server.sharedKey);
    const [value, setValue] = useState('');

    const submit = () => save.mutate({ id: server.id, value: value.trim() }, {
        onSuccess: () => { setValue(''); setOpen(false); toast.success(t('mcp_library.me.saved', 'Your key for {name} is saved', { name: server.name })); },
    });

    return (
        <li className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center gap-3">
                <ServerLogo server={{ id: server.catalogId, name: server.name }} />
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{server.name}</div>
                    <div className="text-[11.5px] text-[var(--text-tertiary)] truncate">{server.host}</div>
                </div>
                {server.connected
                    ? <span className={CHIP_SUCCESS}><CheckCircle2 size={11} aria-hidden="true" />{t('mcp_library.me.connected', 'Your key')}</span>
                    : server.sharedKey
                        ? <span className={CHIP}>{t('mcp_library.me.shared', 'Organisation key')}</span>
                        : <span className={CHIP}>{t('mcp_library.me.not_connected', 'Not connected')}</span>}
                {!open && (
                    <button type="button" className={QUIET_BTN} onClick={() => setOpen(true)}>
                        {server.connected ? t('mcp_library.me.replace', 'Replace') : t('mcp_library.me.add', 'Add your key')}
                    </button>
                )}
            </div>
            {open && (
                <div className="flex flex-col gap-1.5 pl-11">
                    <label htmlFor={inputId} className="text-[12px] font-medium text-[var(--text-secondary)]">{server.credential.label}</label>
                    <div className="flex gap-2">
                        <input id={inputId} type="password" className={`${INPUT} font-mono`} value={value} autoComplete="new-password" spellCheck={false}
                            onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && value.trim()) submit(); }} />
                        <button type="button" className={PRIMARY_BTN} onClick={submit} disabled={!value.trim() || save.isPending}>
                            {save.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                            {t('mcp_library.drawer.check_and_save', 'Check and save')}
                        </button>
                    </div>
                    <p className={HINT}>
                        {server.credential.help || t('mcp_library.me.hint', 'Stored encrypted, only ever sent to {host}, and only used for your own requests.', { host: server.host || '' })}
                        {server.credential.helpUrl && (
                            <>{' '}<a href={server.credential.helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[var(--accent-primary)] hover:underline">{t('mcp_library.wizard.create_key', 'Create one')}<ExternalLink size={10} aria-hidden="true" /></a></>
                        )}
                    </p>
                    {server.sharedKey && !server.connected && (
                        <p className={HINT}>{t('mcp_library.me.shared_hint', 'Your organisation already shares a key. Add your own only if you should act with your own permissions.')}</p>
                    )}
                    {server.connected && (
                        <div>
                            <button type="button" className={QUIET_BTN} onClick={() => remove.mutate(server.id)} disabled={remove.isPending}>
                                {t('mcp_library.me.remove', 'Remove my key')}
                            </button>
                        </div>
                    )}
                </div>
            )}
            {(save.isError || remove.isError) && <div role="alert" className={ALERT_ERROR}>{errorText(t, save.error || remove.error)}</div>}
        </li>
    );
}

/**
 * Settings → Connections: the MCP servers your organisation added that take
 * a key, and your own key for each. Renders nothing when there are none.
 */
export default function OrgMcpConnections() {
    const { t } = useTranslation();
    const query = useMyMcpServersQuery();
    const servers = query.data ?? [];
    if (servers.length === 0) return null;
    return (
        <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2 text-[var(--text-muted)]">
                {t('mcp_library.me.title', 'MCP servers from your organisation')}
            </p>
            <ul className="m-0 p-0 list-none rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-secondary)] divide-y divide-[var(--border-subtle)]">
                {servers.map(s => <ServerKeyRow key={s.id} server={s} />)}
            </ul>
        </div>
    );
}
