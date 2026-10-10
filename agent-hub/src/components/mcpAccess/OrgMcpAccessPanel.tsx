import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useMcpAccessQuery, useMcpMembersQuery, useSaveMcpAccess } from '../../api/queries/mcpAccess';
import type { McpAccessPolicy, McpUserMode } from '../../api/queries/mcpAccess';
import { ORG_ROLES } from '../../config/orgRoles';
import { useTranslation } from '../../hooks/useTranslation';
import toast from '../shared/Toast';
import Toggle from '../shared/Toggle';
import { ALERT_ERROR, ALERT_WARNING, HINT, INPUT, LABEL, PRIMARY_BTN, QUIET_BTN, SECONDARY_BTN } from '../mcpLibrary/ui';
import { invalidEntries, ipInList, parseList } from './mcpAccessLib';

/** The form's own shape: the address list is text while it is being typed. */
interface Draft {
    enabled: boolean;
    ipText: string;
    mode: McpUserMode;
    roles: string[];
    userIds: string[];
    rejectLegacyTokens: boolean;
}

const toDraft = (p: McpAccessPolicy): Draft => ({
    enabled: p.enabled,
    ipText: p.ipAllowlist.join('\n'),
    mode: p.allowedUsers.mode,
    roles: p.allowedUsers.roles,
    userIds: p.allowedUsers.userIds,
    rejectLegacyTokens: p.rejectLegacyTokens,
});

const toggled = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

function RolePicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
    const { t } = useTranslation();
    return (
        <fieldset className="m-0 p-0 border-0">
            <legend className={LABEL}>{t('mcp_access.org.roles', 'Roles')}</legend>
            <div className="flex flex-wrap gap-2">
                {ORG_ROLES.map(r => (
                    <label key={r.id} className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-primary)] cursor-pointer">
                        <input type="checkbox" checked={value.includes(r.id)} onChange={() => onChange(toggled(value, r.id))} />
                        {r.label}
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

function MemberPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
    const { t } = useTranslation();
    const members = useMcpMembersQuery({ enabled: true });
    const [search, setSearch] = useState('');
    const shown = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (members.data ?? []).filter(m => !q || m.label.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
    }, [members.data, search]);

    return (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
            <legend className={LABEL}>{t('mcp_access.org.members', 'Members')}</legend>
            <input className={INPUT} type="search" value={search} onChange={e => setSearch(e.target.value)}
                aria-label={t('mcp_access.org.members_search', 'Search members')}
                placeholder={t('mcp_access.org.members_search', 'Search members')} />
            {members.isPending && <p className={`${HINT} mt-0`} role="status">{t('mcp_access.org.members_loading', 'Loading members…')}</p>}
            {members.isError && <div role="alert" className={ALERT_ERROR}>{members.error.message}</div>}
            {members.isSuccess && shown.length === 0 && <p className={`${HINT} mt-0`}>{t('mcp_access.org.members_none', 'No members found.')}</p>}
            {shown.length > 0 && (
                <ul className="m-0 p-0 list-none max-h-56 overflow-y-auto rounded-lg border border-[var(--border-default)] divide-y divide-[var(--border-subtle)]">
                    {shown.map(m => (
                        <li key={m.id}>
                            <label className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] cursor-pointer">
                                <input type="checkbox" checked={value.includes(m.id)} onChange={() => onChange(toggled(value, m.id))} />
                                <span className="truncate">{m.label}</span>
                                {m.email && m.email !== m.label && <span className="truncate text-[var(--text-tertiary)]">{m.email}</span>}
                            </label>
                        </li>
                    ))}
                </ul>
            )}
        </fieldset>
    );
}

interface NetworksProps {
    text: string;
    enabled: boolean;
    callerIp: string | null;
    onChange: (text: string) => void;
}

/** The allowed networks, with the lockout warning when the admin's own address would fall outside. */
function NetworksField({ text, enabled, callerIp, onChange }: NetworksProps) {
    const { t } = useTranslation();
    const ips = useMemo(() => parseList(text), [text]);
    const badIps = useMemo(() => invalidEntries(ips), [ips]);
    const callerIn = !!callerIp && ipInList(callerIp, ips);
    const lockout = enabled && ips.length > 0 && badIps.length === 0 && !!callerIp && !callerIn;
    return (
        <div>
            <label className={LABEL} htmlFor="mcp-access-ips">{t('mcp_access.org.ips', 'Allowed networks')}</label>
            <textarea id="mcp-access-ips" className={`${INPUT} font-mono`} rows={4} spellCheck={false} value={text}
                placeholder={t('mcp_access.create.ips_placeholder', '203.0.113.0/24')}
                onChange={e => onChange(e.target.value)} />
            <p className={HINT}>{t('mcp_access.org.ips_desc', 'Only these addresses and ranges (CIDR) can use MCP. One per line. Leave empty to allow any address.')}</p>
            {badIps.length > 0 && <p className="m-0 mt-1 text-[11.5px] text-[var(--error-ink)]">{t('mcp_access.ips_invalid', 'Not a valid address or range: {list}', { list: badIps.join(', ') })}</p>}
            {callerIp && (
                <p className={`${HINT} flex flex-wrap items-center gap-2`}>
                    {t('mcp_access.org.caller', 'Your current address is {ip}.', { ip: callerIp })}
                    {!callerIn && (
                        <button type="button" className={QUIET_BTN} onClick={() => onChange([...ips, callerIp].join('\n'))}>
                            {t('mcp_access.org.add_mine', 'Add my address')}
                        </button>
                    )}
                </p>
            )}
            {lockout && (
                <div role="alert" className={`${ALERT_WARNING} mt-2`}>
                    <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden="true" />
                    <span>{t('mcp_access.org.lockout', 'Your current address ({ip}) is not in this list. If you save, you would lock yourself out of MCP from this network. The web app is not affected.', { ip: callerIp })}</span>
                </div>
            )}
        </div>
    );
}

/** Who may use MCP: everyone, some roles, or named members. */
function UsersField({ form, onPatch }: { form: Draft; onPatch: (p: Partial<Draft>) => void }) {
    const { t } = useTranslation();
    const modes: Array<{ value: McpUserMode; label: string }> = [
        { value: 'all', label: t('mcp_access.org.users_all', 'Everyone in the organisation') },
        { value: 'roles', label: t('mcp_access.org.users_roles', 'Specific roles') },
        { value: 'users', label: t('mcp_access.org.users_users', 'Specific members') },
    ];
    const nobody = (form.mode === 'roles' && form.roles.length === 0) || (form.mode === 'users' && form.userIds.length === 0);
    return (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-3">
            <legend className={LABEL}>{t('mcp_access.org.users', 'Who may use MCP')}</legend>
            <div className="flex flex-wrap gap-4">
                {modes.map(m => (
                    <label key={m.value} className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-primary)] cursor-pointer">
                        <input type="radio" name="mcp-access-mode" checked={form.mode === m.value} onChange={() => onPatch({ mode: m.value })} />
                        {m.label}
                    </label>
                ))}
            </div>
            {form.mode === 'roles' && <RolePicker value={form.roles} onChange={roles => onPatch({ roles })} />}
            {form.mode === 'users' && <MemberPicker value={form.userIds} onChange={userIds => onPatch({ userIds })} />}
            {nobody && <p className="m-0 text-[11.5px] text-[var(--warning-ink)]">{t('mcp_access.org.nobody', 'Nobody is selected, so nobody could use MCP.')}</p>}
        </fieldset>
    );
}

function toPolicy(form: Draft): McpAccessPolicy {
    return {
        enabled: form.enabled,
        ipAllowlist: parseList(form.ipText),
        allowedUsers: {
            mode: form.mode,
            roles: form.mode === 'roles' ? form.roles : [],
            userIds: form.mode === 'users' ? form.userIds : [],
        },
        rejectLegacyTokens: form.rejectLegacyTokens,
    };
}

/** The form itself, once the policy has loaded; `edited` is null until the admin changes something. */
function PolicyForm({ base, callerIp }: { base: Draft; callerIp: string | null }) {
    const { t } = useTranslation();
    const save = useSaveMcpAccess();
    const [edited, setEdited] = useState<Draft | null>(null);
    const form = edited ?? base;
    const patch = (p: Partial<Draft>) => setEdited({ ...form, ...p });
    const hasBadIps = invalidEntries(parseList(form.ipText)).length > 0;

    const submit = () => {
        if (hasBadIps || save.isPending) return;
        save.mutate(toPolicy(form), {
            onSuccess: () => { setEdited(null); toast.success(t('mcp_access.org.saved', 'MCP access saved')); },
        });
    };

    return (
        <>
            <Toggle
                label={t('mcp_access.org.enabled', 'Allow MCP access')}
                description={t('mcp_access.org.enabled_desc', 'When off, every MCP token in this organisation is refused.')}
                checked={form.enabled}
                onChange={enabled => patch({ enabled })}
            />
            <NetworksField text={form.ipText} enabled={form.enabled} callerIp={callerIp} onChange={ipText => patch({ ipText })} />
            <UsersField form={form} onPatch={patch} />
            <Toggle
                label={t('mcp_access.org.reject_legacy', 'Refuse legacy tokens')}
                description={t('mcp_access.org.reject_legacy_desc', 'Legacy tokens cannot be limited to servers or tools. Turn this on once everyone has moved to named tokens.')}
                checked={form.rejectLegacyTokens}
                onChange={rejectLegacyTokens => patch({ rejectLegacyTokens })}
            />
            {save.isError && <div role="alert" className={ALERT_ERROR}>{save.error.message}</div>}
            <div>
                <button type="button" className={PRIMARY_BTN} onClick={submit} disabled={edited === null || hasBadIps || save.isPending}>
                    {save.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                    {save.isPending ? t('mcp_access.org.saving', 'Saving…') : t('mcp_access.org.save', 'Save')}
                </button>
            </div>
        </>
    );
}

/**
 * Organisation → MCP access: the organisation-wide rules every MCP request
 * passes through, whichever token it carries. Org admins only (the caller
 * mounts it behind the admin check; the server enforces it again).
 */
export default function OrgMcpAccessPanel() {
    const { t } = useTranslation();
    const query = useMcpAccessQuery();
    // The form re-seeds from the server's policy after a save (its cache entry is replaced).
    const base = useMemo(() => (query.data ? toDraft(query.data.policy) : null), [query.data]);

    return (
        <section aria-labelledby="mcp-access-title" className="flex flex-col gap-5 max-w-3xl">
            <div className="flex items-start gap-3">
                <ShieldCheck className="w-5 h-5 mt-0.5 text-[var(--accent-primary)] shrink-0" aria-hidden="true" />
                <div>
                    <h3 id="mcp-access-title" className="m-0 text-sm font-semibold text-[var(--text-primary)]">{t('mcp_access.org.title', 'MCP access')}</h3>
                    <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">
                        {t('mcp_access.org.intro', 'Control how external MCP clients such as Claude Code reach this organisation. These rules apply to MCP only, not to the web app.')}
                    </p>
                </div>
            </div>
            {query.isPending && (
                <div role="status" className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    {t('mcp_access.org.loading', 'Loading the MCP access policy…')}
                </div>
            )}
            {query.isError && (
                <div role="alert" className={ALERT_ERROR}>
                    <span className="flex-1">{query.error.message}</span>
                    <button type="button" className={SECONDARY_BTN} onClick={() => query.refetch()}>{t('mcp_access.tokens.retry', 'Try again')}</button>
                </div>
            )}
            {base && <PolicyForm key={JSON.stringify(base)} base={base} callerIp={query.data?.callerIp ?? null} />}
        </section>
    );
}
