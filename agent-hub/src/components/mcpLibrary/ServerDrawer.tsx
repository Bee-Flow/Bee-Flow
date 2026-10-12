import { BadgeCheck, ExternalLink, KeyRound, Loader2, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import Modal from '../shared/Modal';
import Toggle from '../shared/Toggle';
import useConfirm from '../shared/useConfirm';
import toast from '../shared/Toast';
import { useRefreshMcpServer, useSetSharedMcpKey, useUninstallMcpServer, useUpdateMcpServer } from '../../api/queries/mcpLibrary';
import type { CatalogEntry, InstalledServer } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import AccessPicker from './AccessPicker';
import type { AccessValue } from './AccessPicker';
import { InstalledStatus } from './LibraryCards';
import { blockedText, errorText } from './libraryText';
import ServerLogo from './ServerLogo';
import ToolPicker from './ToolPicker';
import { ALERT_ERROR, ALERT_WARNING, CHIP_SUCCESS, DANGER_BTN, EYEBROW, HINT, INPUT, PRIMARY_BTN, QUIET_BTN, SECONDARY_BTN } from './ui';

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
    return (
        <section className="flex flex-col gap-2 py-4 border-b border-[var(--border-subtle)] last:border-b-0">
            <div className="flex items-center gap-2">
                <h3 className={EYEBROW}>{title}</h3>
                {aside && <span className="ml-auto">{aside}</span>}
            </div>
            {children}
        </section>
    );
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

interface ServerDrawerProps {
    server: InstalledServer;
    catalog: CatalogEntry | null;
    groups: Array<{ id: string; name: string }>;
    onClose: () => void;
}

/** Everything about one installed server, and every change an admin can make to it. */
export default function ServerDrawer({ server, catalog, groups, onClose }: ServerDrawerProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const update = useUpdateMcpServer();
    const refresh = useRefreshMcpServer();
    const setKey = useSetSharedMcpKey();
    const uninstall = useUninstallMcpServer();
    const keyId = useId();

    const enabledNames = server.tools.filter(tl => tl.enabled).map(tl => tl.name);
    const [tools, setTools] = useState<string[]>(enabledNames);
    const [access, setAccess] = useState<AccessValue>(server.access.mode === 'nobody' ? { mode: 'everyone', groupIds: [] } : server.access);
    const [keyOpen, setKeyOpen] = useState(false);
    const [keyValue, setKeyValue] = useState('');
    const [newTools, setNewTools] = useState<string[]>([]);

    // The server row is replaced after every save: when what is stored
    // changes, the edit state starts again from it (adjusted while rendering,
    // React's pattern for state derived from a changing prop).
    const enabledKey = enabledNames.join('\n');
    const accessKey = `${server.access.mode}:${server.access.groupIds.join(',')}`;
    const [seen, setSeen] = useState({ enabledKey, accessKey });
    if (seen.enabledKey !== enabledKey || seen.accessKey !== accessKey) {
        setSeen({ enabledKey, accessKey });
        if (seen.enabledKey !== enabledKey) setTools(enabledNames);
        if (seen.accessKey !== accessKey) setAccess(server.access.mode === 'nobody' ? { mode: 'everyone', groupIds: [] } : server.access);
    }

    const toolsDirty = !sameList(tools, enabledNames);
    const accessDirty = access.mode !== server.access.mode || access.groupIds.join(',') !== server.access.groupIds.join(',');
    const accessReady = access.mode === 'everyone' || access.groupIds.length > 0;
    const anyBusy = update.isPending || refresh.isPending || setKey.isPending || uninstall.isPending;

    const saveTools = () => update.mutate({ id: server.id, patch: { tools } }, {
        onSuccess: () => { setNewTools([]); toast.success(t('mcp_library.drawer.tools_saved', 'Tools saved')); },
    });
    const saveAccess = () => update.mutate({ id: server.id, patch: { access: access.mode === 'groups' ? { mode: 'groups', groupIds: access.groupIds } : { mode: 'everyone' } } }, {
        onSuccess: () => toast.success(t('mcp_library.drawer.access_saved', 'Access saved')),
    });
    const toggleRunning = (next: boolean) => update.mutate({ id: server.id, patch: { enabled: next } });
    const checkForNew = () => refresh.mutate(server.id, {
        onSuccess: (res) => {
            setNewTools(res.newTools);
            if (res.newTools.length === 0) toast.success(t('mcp_library.drawer.no_new_tools', 'No new tools'));
        },
    });
    const saveKey = () => setKey.mutate({ id: server.id, value: keyValue.trim() }, {
        onSuccess: () => { setKeyOpen(false); setKeyValue(''); toast.success(t('mcp_library.drawer.key_saved', 'Key saved')); },
    });
    const usePersonalKeys = async () => {
        const ok = await confirm({
            title: t('mcp_library.drawer.personal_confirm_title', 'Let everyone use their own key?'),
            description: t('mcp_library.drawer.personal_confirm_desc', 'The shared key stops being lent to the organisation. Members without their own key lose access until they add one.'),
            confirmLabel: t('mcp_library.drawer.personal_confirm', 'Switch to own keys'),
        });
        if (ok) update.mutate({ id: server.id, patch: { credentialMode: 'personal' } });
    };
    const remove = async () => {
        const ok = await confirm({
            title: t('mcp_library.drawer.remove_title', 'Remove {name}?', { name: server.name }),
            description: t('mcp_library.drawer.remove_desc', 'Agents lose its tools straight away, and every stored key for it, the shared key and members\' own keys, is deleted.'),
            confirmLabel: t('mcp_library.drawer.remove', 'Remove'),
            destructive: true,
        });
        if (ok) uninstall.mutate(server.id, { onSuccess: () => { toast.success(t('mcp_library.drawer.removed', '{name} removed', { name: server.name })); onClose(); } });
    };

    const mutationError = update.error || refresh.error || setKey.error || uninstall.error;

    return (
        <Modal
            open
            onClose={onClose}
            placement="right"
            size="md"
            title={(
                <span className="flex items-center gap-2.5 min-w-0">
                    <ServerLogo server={{ id: server.catalogId, name: server.name, repository: catalog?.repository, homepage: catalog?.homepage }} />
                    <span className="truncate">{server.name}</span>
                </span>
            )}
            description={<InstalledStatus server={server} />}
        >
            <div className="flex flex-col -my-4">
                {server.blockedByPolicy && (
                    <div className={`${ALERT_WARNING} mt-4`}>
                        <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <span>{blockedText(t, server.blockedReason)}</span>
                    </div>
                )}
                {mutationError && (
                    <div role="alert" className={`${ALERT_ERROR} mt-4`}>{errorText(t, mutationError)}</div>
                )}

                <Section title={t('mcp_library.drawer.status', 'Status')}>
                    <Toggle
                        checked={server.status === 'active'}
                        onChange={toggleRunning}
                        // Blocked by policy: switching it ON is refused, but
                        // switching it OFF must stay possible, or it would start
                        // running again by itself once the policy is relaxed.
                        disabled={anyBusy || (server.blockedByPolicy && server.status !== 'active')}
                        size="sm"
                        label={t('mcp_library.drawer.running', 'Running')}
                        description={t('mcp_library.drawer.running_desc', 'Switched off, agents lose its tools but the settings and keys stay.')}
                    />
                </Section>

                <Section title={t('mcp_library.drawer.connection', 'Connection')}>
                    <div className="flex flex-wrap items-center gap-2">
                        <code className="text-[12px] text-[var(--text-primary)] break-all">{server.url}</code>
                        {server.official && <span className={CHIP_SUCCESS}><BadgeCheck size={11} aria-hidden="true" />{t('mcp_library.official', 'Official')}</span>}
                    </div>
                    {server.docsUrl && (
                        <a href={server.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 text-[12px] text-[var(--accent-primary)] hover:underline">
                            {t('mcp_library.wizard.vendor_docs', 'Vendor documentation')}<ExternalLink size={11} aria-hidden="true" />
                        </a>
                    )}
                </Section>

                {server.credentialMode !== 'none' && (
                    <Section title={t('mcp_library.drawer.key', 'Key')}>
                        <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-[var(--text-primary)]">
                            <KeyRound size={13} className="text-[var(--text-tertiary)]" aria-hidden="true" />
                            {server.credentialMode === 'shared'
                                ? t('mcp_library.key.shared', 'One key for everyone')
                                : t('mcp_library.key.personal', 'Everyone uses their own key')}
                        </p>
                        <p className={HINT}>
                            {server.credentialMode === 'shared'
                                ? t('mcp_library.drawer.shared_hint', 'Stored encrypted. Every member\'s requests use it, so keep its permissions narrow.')
                                : t('mcp_library.drawer.personal_hint', 'Members add their own key under Settings → Connections; until they do, they cannot use it.')}
                        </p>
                        {keyOpen ? (
                            <div className="flex flex-col gap-2">
                                <label htmlFor={keyId} className="sr-only">{server.credential?.label || t('mcp_library.wizard.key', 'API key or token')}</label>
                                <input id={keyId} type="password" className={`${INPUT} font-mono`} value={keyValue} autoComplete="new-password" spellCheck={false}
                                    onChange={e => setKeyValue(e.target.value)} placeholder={server.credential?.label || t('mcp_library.wizard.key_placeholder', 'Paste the key')} />
                                <div className="flex gap-2">
                                    <button type="button" className={PRIMARY_BTN} onClick={saveKey} disabled={!keyValue.trim() || anyBusy}>
                                        {setKey.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                                        {t('mcp_library.drawer.check_and_save', 'Check and save')}
                                    </button>
                                    <button type="button" className={SECONDARY_BTN} onClick={() => { setKeyOpen(false); setKeyValue(''); }}>
                                        {t('mcp_library.drawer.cancel', 'Cancel')}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                <button type="button" className={SECONDARY_BTN} onClick={() => setKeyOpen(true)} disabled={anyBusy}>
                                    {server.credentialMode === 'shared'
                                        ? t('mcp_library.drawer.replace_key', 'Replace key')
                                        : t('mcp_library.drawer.share_a_key', 'Use one key for everyone')}
                                </button>
                                {server.credentialMode === 'shared' && (
                                    <button type="button" className={QUIET_BTN} onClick={usePersonalKeys} disabled={anyBusy}>
                                        {t('mcp_library.drawer.personal_confirm', 'Switch to own keys')}
                                    </button>
                                )}
                            </div>
                        )}
                    </Section>
                )}

                <Section title={t('mcp_library.access.label', 'Who can use it')}>
                    <AccessPicker value={access} onChange={setAccess} groups={groups} disabled={anyBusy} />
                    {accessDirty && (
                        <div>
                            <button type="button" className={PRIMARY_BTN} onClick={saveAccess} disabled={!accessReady || anyBusy}>
                                {t('mcp_library.drawer.save_access', 'Save access')}
                            </button>
                        </div>
                    )}
                </Section>

                <Section
                    title={t('mcp_library.review.tools', 'Tools')}
                    aside={(
                        <button type="button" className={QUIET_BTN} onClick={checkForNew} disabled={anyBusy || server.blockedByPolicy}>
                            <RefreshCw size={12} className={refresh.isPending ? 'animate-spin' : ''} aria-hidden="true" />
                            {t('mcp_library.drawer.check_new', 'Check for new tools')}
                        </button>
                    )}
                >
                    {newTools.length > 0 && (
                        <p className="m-0 text-[12px] text-[var(--info-ink)]">
                            {t('mcp_library.drawer.new_tools', 'The server has new tools. They stay off until you switch them on.')}
                        </p>
                    )}
                    <ToolPicker tools={server.tools} selected={tools} onChange={setTools} disabled={anyBusy} newTools={newTools} />
                    {toolsDirty && (
                        <div>
                            <button type="button" className={PRIMARY_BTN} onClick={saveTools} disabled={tools.length === 0 || anyBusy}>
                                {update.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                                {t('mcp_library.drawer.save_tools', 'Save tools')}
                            </button>
                        </div>
                    )}
                </Section>

                <Section title={t('mcp_library.drawer.danger', 'Remove')}>
                    <p className="m-0 text-[12px] leading-snug text-[var(--text-tertiary)]">
                        {t('mcp_library.drawer.remove_hint', 'Removes the server for the whole organisation and deletes every key stored for it.')}
                    </p>
                    <div>
                        <button type="button" className={DANGER_BTN} onClick={remove} disabled={anyBusy}>
                            <Trash2 size={13} aria-hidden="true" />
                            {t('mcp_library.drawer.remove_button', 'Remove server')}
                        </button>
                    </div>
                </Section>
            </div>
            {confirmDialog}
        </Modal>
    );
}
