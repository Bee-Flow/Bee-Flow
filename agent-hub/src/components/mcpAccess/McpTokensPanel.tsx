import { KeyRound, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useMcpTokensQuery, useRevokeMcpToken, useSetMcpTokenEnabled } from '../../api/queries/mcpAccess';
import type { McpEligibility, McpTokenRecord } from '../../api/queries/mcpAccess';
import { useTranslation } from '../../hooks/useTranslation';
import toast from '../shared/Toast';
import Toggle from '../shared/Toggle';
import useConfirm from '../shared/useConfirm';
import { ALERT_ERROR, ALERT_INFO, ALERT_WARNING, CHIP, CHIP_ERROR, CHIP_WARNING, DANGER_BTN, HINT, PRIMARY_BTN, SECONDARY_BTN } from '../mcpLibrary/ui';
import McpTokenCreateModal from './McpTokenCreateModal';
import { MCP_SERVERS } from './mcpAccessLib';
import { useServerName } from './serverNames';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();

interface TokenRowProps {
    token: McpTokenRecord;
    onRevoke: (token: McpTokenRecord) => void;
    onToggle: (token: McpTokenRecord, enabled: boolean) => void;
    busy: boolean;
    eligibility?: McpEligibility;
}

/** What a row needs to know about its token: lifecycle flags, granted servers and those its owner lost. */
function tokenState(token: McpTokenRecord, eligibility?: McpEligibility) {
    const revoked = !!token.revokedAt;
    const expired = !revoked && !!token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now();
    const off = !revoked && (token.enabled === false || !!token.disabledAt);
    const granted = MCP_SERVERS.filter(s => token.scopes[s.id]);
    // A server the owner no longer has access to: the gate refuses it on every call.
    const lost = revoked ? [] : granted.filter(s => eligibility?.[s.id]?.reason === 'no_access');
    return { revoked, expired, off, granted, lost };
}

function TokenRow({ token, onRevoke, onToggle, busy, eligibility }: TokenRowProps) {
    const { t } = useTranslation();
    const serverName = useServerName();
    const { revoked, expired, off, granted, lost } = tokenState(token, eligibility);
    const levelWord = (level: string) => (level === 'write' ? t('mcp_access.level.write', 'read and write') : t('mcp_access.level.read', 'read only'));

    return (
        <li className={`flex flex-col gap-2 px-4 py-3 ${revoked || expired || off ? 'opacity-70' : ''}`}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-[var(--text-primary)] break-all">{token.name}</span>
                {revoked && <span className={CHIP_ERROR}>{t('mcp_access.tokens.revoked', 'Revoked')}</span>}
                {off && <span className={CHIP}>{t('mcp_access.tokens.disabled', 'Switched off')}</span>}
                {expired && <span className={CHIP_WARNING}>{t('mcp_access.tokens.expired', 'Expired')}</span>}
                <div className="flex-1" />
                {!revoked && (
                    <Toggle size="sm" checked={!off} onChange={on => onToggle(token, on)}
                        ariaLabel={t('mcp_access.tokens.switch_named', 'Token {name} on or off', { name: token.name })} />
                )}
                {!revoked && (
                    <button type="button" className={DANGER_BTN} disabled={busy} onClick={() => onRevoke(token)}
                        aria-label={t('mcp_access.tokens.revoke_named', 'Revoke {name}', { name: token.name })}>
                        {t('mcp_access.tokens.revoke', 'Revoke')}
                    </button>
                )}
            </div>
            <div className="flex flex-wrap gap-1.5">
                {granted.map((s) => {
                    const scope = token.scopes[s.id]!;
                    return (
                        <span key={s.id} className={CHIP}>
                            {serverName(s.id)}: {levelWord(scope.level)}
                            {s.id === 'cms' && scope.publish ? `, ${t('mcp_access.tokens.may_publish', 'may publish')}` : ''}
                        </span>
                    );
                })}
                {granted.length === 0 && <span className={CHIP}>{t('mcp_access.tokens.no_servers', 'No servers')}</span>}
            </div>
            {lost.map(s => (
                <p key={s.id} className="m-0 text-[11.5px] text-[var(--warning-ink)]">
                    {t('mcp_access.tokens.lost_access', 'You no longer have access to {server}, so this token cannot use it.', { server: serverName(s.id) })}
                </p>
            ))}
            {granted.map((s) => {
                const tools = token.scopes[s.id]?.tools;
                if (!tools?.length) return null;
                return (
                    <p key={s.id} className={`${HINT} mt-0 break-words`}>
                        {t('mcp_access.tokens.tools_only', '{server}: only {tools}', { server: serverName(s.id), tools: tools.join(', ') })}
                    </p>
                );
            })}
            <p className={`${HINT} mt-0`}>
                {token.ipAllowlist.length
                    ? t('mcp_access.tokens.ips', 'Allowed from {list}', { list: token.ipAllowlist.join(', ') })
                    : t('mcp_access.tokens.any_ip', 'Any address your organisation allows')}
            </p>
            <p className={`${HINT} mt-0`}>
                {t('mcp_access.tokens.created', 'Created {date}', { date: fmtDate(token.createdAt) })}
                {' · '}
                {token.expiresAt ? t('mcp_access.tokens.expires', 'Expires {date}', { date: fmtDate(token.expiresAt) }) : t('mcp_access.tokens.no_expiry', 'No expiry')}
                {' · '}
                {token.lastUsedAt ? t('mcp_access.tokens.last_used', 'Last used {date}', { date: fmtDate(token.lastUsedAt) }) : t('mcp_access.tokens.never_used', 'Never used')}
            </p>
        </li>
    );
}

function PolicyNotice() {
    const { t } = useTranslation();
    return (
        <div className={ALERT_WARNING} role="note">
            <span>{t('mcp_access.tokens.policy_blocked', 'Your organisation does not allow you to use MCP, so you cannot create tokens.')}</span>
        </div>
    );
}

/**
 * Settings → MCP tokens: the named tokens an external MCP client (Claude Code,
 * Cursor) uses to reach this account, each limited to the servers and tools
 * chosen when it was made. A token's secret is shown once, at creation.
 */
export default function McpTokensPanel() {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const query = useMcpTokensQuery();
    const revoke = useRevokeMcpToken();
    const setEnabled = useSetMcpTokenEnabled();
    const [creating, setCreating] = useState(false);

    const onRevoke = async (token: McpTokenRecord) => {
        const ok = await confirm({
            title: t('mcp_access.tokens.revoke_title', 'Revoke "{name}"?', { name: token.name }),
            description: t('mcp_access.tokens.revoke_desc', 'Every client that uses this token loses access straight away. This cannot be undone.'),
            confirmLabel: t('mcp_access.tokens.revoke_confirm', 'Revoke token'),
            cancelLabel: t('mcp_access.create.cancel', 'Cancel'),
            destructive: true,
        });
        if (!ok) return;
        revoke.mutate(token.id, { onSuccess: () => toast.success(t('mcp_access.tokens.revoked_toast', 'Token revoked')) });
    };

    const onToggle = (token: McpTokenRecord, enabled: boolean) => {
        setEnabled.mutate({ id: token.id, enabled }, {
            onError: err => toast.error(err.message),
        });
    };

    const tokens = query.data?.tokens ?? [];
    const eligibility = query.data?.eligibility;
    const policyBlocked = eligibility?.policy.allowed === false;

    return (
        <section aria-labelledby="mcp-tokens-title" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 flex flex-col gap-4">
            <div className="flex items-start gap-3">
                <KeyRound className="w-5 h-5 mt-0.5 text-[var(--accent-primary)] shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h3 id="mcp-tokens-title" className="m-0 text-sm font-semibold text-[var(--text-primary)]">{t('mcp_access.tokens.title', 'MCP tokens')}</h3>
                    <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">
                        {t('mcp_access.tokens.intro', 'Give Claude Code, Cursor or another MCP client its own token, limited to the servers and tools you choose. Each token can be revoked on its own.')}
                    </p>
                </div>
                <button type="button" className={PRIMARY_BTN} disabled={policyBlocked} onClick={() => setCreating(true)}>
                    <Plus size={13} aria-hidden="true" />
                    {t('mcp_access.tokens.create', 'Create token')}
                </button>
            </div>

            {policyBlocked && <PolicyNotice />}

            {query.data?.legacy.exists && (
                <div className={ALERT_INFO} role="note">
                    <div>
                        <strong className="font-semibold">{t('mcp_access.tokens.legacy_title', 'Legacy token')}</strong>
                        {' '}
                        {t('mcp_access.tokens.legacy_body', 'You also have a legacy MCP token, for example from the mobile app. It reaches every MCP server and cannot be limited. Your organisation can choose to refuse legacy tokens.')}
                    </div>
                </div>
            )}

            {query.isPending && (
                <div role="status" className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    {t('mcp_access.tokens.loading', 'Loading your MCP tokens…')}
                </div>
            )}

            {query.isError && (
                <div role="alert" className={ALERT_ERROR}>
                    <span className="flex-1">{query.error.message}</span>
                    <button type="button" className={SECONDARY_BTN} onClick={() => query.refetch()}>{t('mcp_access.tokens.retry', 'Try again')}</button>
                </div>
            )}

            {query.isSuccess && tokens.length === 0 && (
                <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('mcp_access.tokens.empty', 'You have no MCP tokens yet.')}</p>
            )}

            {tokens.length > 0 && (
                <ul className="m-0 p-0 list-none rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] divide-y divide-[var(--border-subtle)]">
                    {tokens.map(tok => <TokenRow key={tok.id} token={tok} onRevoke={onRevoke} onToggle={onToggle} busy={revoke.isPending} eligibility={eligibility} />)}
                </ul>
            )}

            {revoke.isError && <div role="alert" className={ALERT_ERROR}>{revoke.error.message}</div>}

            {creating && <McpTokenCreateModal onClose={() => setCreating(false)} />}
            {confirmDialog}
        </section>
    );
}
