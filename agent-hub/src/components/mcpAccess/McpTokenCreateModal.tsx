import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useCreateMcpToken, useMcpTokensQuery } from '../../api/queries/mcpAccess';
import type { McpEligibility, McpLevel, McpServerEligibility, McpScopes, McpServerId, McpTokenCreated } from '../../api/queries/mcpAccess';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE } from '../../utils/helpers';
import Modal from '../shared/Modal';
import toast from '../shared/Toast';
import Toggle from '../shared/Toggle';
import { ALERT_ERROR, ALERT_WARNING, HINT, INPUT, LABEL, PRIMARY_BTN, QUIET_BTN, SECONDARY_BTN } from '../mcpLibrary/ui';
import { MCP_SERVERS, claudeAddCommand, expiryToIso, invalidEntries, parseList, parseToolList } from './mcpAccessLib';
import type { ExpiryChoice, McpServerInfo } from './mcpAccessLib';
import { useServerName } from './serverNames';

interface ServerDraft { on: boolean; level: McpLevel; tools: string }

const EMPTY_SERVERS: Record<McpServerId, ServerDraft> = {
    integrations: { on: false, level: 'read', tools: '' },
    automations: { on: false, level: 'read', tools: '' },
    studio: { on: false, level: 'read', tools: '' },
    cms: { on: false, level: 'read', tools: '' },
};

/** Where an MCP client reaches this server: what the server says, else the API's own origin when it is absolute, else the page's. */
function mcpOrigin(fromServer?: string): string {
    if (fromServer && /^https?:\/\//i.test(fromServer)) return fromServer.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(API_BASE)) return API_BASE.replace(/\/+$/, '');
    return window.location.origin;
}

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

function Reveal({ created, baseUrl, onDone }: { created: McpTokenCreated; baseUrl?: string; onDone: () => void }) {
    const { t } = useTranslation();
    const serverName = useServerName();
    const [copied, setCopied] = useState<string | null>(null);
    const origin = mcpOrigin(baseUrl);
    const enabled = MCP_SERVERS.filter(s => created.record.scopes[s.id]);

    const copy = async (what: string, text: string) => {
        if (await copyText(text)) {
            setCopied(what);
            toast.success(t('mcp_access.reveal.copied', 'Copied'));
        } else {
            toast.error(t('mcp_access.reveal.copy_failed', 'Copying failed. Select the text and copy it by hand.'));
        }
    };

    return (
        <Modal
            open
            onClose={onDone}
            size="lg"
            title={t('mcp_access.reveal.title', 'Your new token')}
            footer={<button type="button" className={PRIMARY_BTN} onClick={onDone}>{t('mcp_access.reveal.done', 'Done')}</button>}
        >
            <div className="flex flex-col gap-4">
                <div className={ALERT_WARNING} role="note">
                    <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden="true" />
                    <span>{t('mcp_access.reveal.once', 'Copy this token now. It is shown only once and cannot be looked up later.')}</span>
                </div>
                <div>
                    <label className={LABEL} htmlFor="mcp-new-token">{t('mcp_access.reveal.token_label', 'Token')}</label>
                    <div className="flex gap-2">
                        <input id="mcp-new-token" readOnly className={`${INPUT} font-mono`} value={created.token} onFocus={e => e.currentTarget.select()} />
                        <button type="button" className={SECONDARY_BTN} onClick={() => copy('token', created.token)}>
                            {copied === 'token' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                            {t('mcp_access.reveal.copy', 'Copy')}
                        </button>
                    </div>
                </div>
                {enabled.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <p className="m-0 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp_access.reveal.commands', 'Connect Claude Code')}</p>
                        {enabled.map((s) => {
                            const command = claudeAddCommand(s, origin, created.token);
                            const name = serverName(s.id);
                            return (
                                <div key={s.id} className="flex items-start gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[11.5px] text-[var(--text-tertiary)]">{name}</div>
                                        <pre className="m-0 mt-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11.5px] font-mono whitespace-pre-wrap break-all text-[var(--text-primary)]">{command}</pre>
                                    </div>
                                    <button type="button" className={QUIET_BTN} aria-label={t('mcp_access.reveal.copy_command', 'Copy command for {server}', { server: name })} onClick={() => copy(s.id, command)}>
                                        {copied === s.id ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </Modal>
    );
}

interface ServerCardProps {
    server: McpServerInfo;
    draft: ServerDraft;
    onPatch: (p: Partial<ServerDraft>) => void;
    publish: boolean;
    onPublish: (on: boolean) => void;
    /** What the caller may put on a token. Absent = everything (an older server). */
    eligibility?: McpServerEligibility;
}

/** One server: its switch, and (when on) access level, optional tool list and, for the CMS, the publish scope. */
function ServerCard({ server, draft, onPatch, publish, onPublish, eligibility }: ServerCardProps) {
    const { t } = useTranslation();
    const serverName = useServerName();
    const groupId = useId();
    const label = serverName(server.id);
    const unavailable = eligibility?.available === false;
    const canWrite = eligibility?.canWrite !== false;
    const mayPublish = eligibility?.canPublish !== false;
    const canPublish = draft.level === 'write' && mayPublish;
    const levels: Array<{ level: McpLevel; label: string }> = [
        { level: 'read', label: t('mcp_access.create.level_read', 'Read only') },
        { level: 'write', label: t('mcp_access.create.level_write', 'Read and write') },
    ];
    return (
        <div role="group" aria-label={label} className="flex flex-col gap-2 p-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]">
            <div className="flex items-center gap-3">
                <Toggle size="sm" checked={draft.on && !unavailable} disabled={unavailable} onChange={on => onPatch({ on })} ariaLabel={label} />
                <span className="text-[13px] font-medium text-[var(--text-primary)]">{label}</span>
                <code className="ml-auto text-[11px] text-[var(--text-tertiary)]">{server.path}</code>
            </div>
            {unavailable && (
                <p className={`${HINT} mt-0`}>{t('mcp_access.create.no_access', "You don't have access to this yourself, so a token can't either.")}</p>
            )}
            {draft.on && !unavailable && (
                <div className="flex flex-col gap-2 pl-1">
                    <div className="flex flex-wrap gap-4 text-[12px] text-[var(--text-primary)]">
                        {levels.map(o => (
                            <label key={o.level} className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input type="radio" name={`${groupId}-level`} checked={draft.level === o.level} disabled={o.level === 'write' && !canWrite} onChange={() => onPatch({ level: o.level })} />
                                {o.label}
                            </label>
                        ))}
                    </div>
                    <textarea className={`${INPUT} font-mono`} rows={2} spellCheck={false}
                        aria-label={t('mcp_access.create.tools', 'Only these tools for {server} (optional)', { server: label })}
                        placeholder={t('mcp_access.create.tools_placeholder', 'tool_one, tool_two')}
                        value={draft.tools} onChange={e => onPatch({ tools: e.target.value })} />
                    <p className={`${HINT} mt-0`}>{t('mcp_access.create.tools_hint', 'Separate names with commas or new lines. Empty means every tool the access level allows.')}</p>
                    {server.id === 'cms' && (
                        <div className="flex flex-col gap-1.5">
                            <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-primary)] cursor-pointer">
                                <input type="checkbox" checked={publish && canPublish} disabled={!canPublish} onChange={e => onPublish(e.target.checked)} />
                                {t('mcp_access.create.publish', 'May publish the website')}
                            </label>
                            <p className={`${HINT} mt-0`}>{t('mcp_access.create.publish_warn', 'Publishing puts changes on the live website. Leave this off unless the client must go live without you. Needs read and write access.')}</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

interface ExpiryProps {
    id: string;
    choice: ExpiryChoice;
    date: string;
    bad: boolean;
    onChoice: (c: ExpiryChoice) => void;
    onDate: (d: string) => void;
}

function ExpiryField({ id, choice, date, bad, onChoice, onDate }: ExpiryProps) {
    const { t } = useTranslation();
    const options: Array<{ value: ExpiryChoice; label: string }> = [
        { value: 'none', label: t('mcp_access.create.expiry_none', 'Never') },
        { value: '30', label: t('mcp_access.create.expiry_30', 'In 30 days') },
        { value: '90', label: t('mcp_access.create.expiry_90', 'In 90 days') },
        { value: '365', label: t('mcp_access.create.expiry_365', 'In a year') },
        { value: 'date', label: t('mcp_access.create.expiry_date', 'On a date') },
    ];
    return (
        <div>
            <label className={LABEL} htmlFor={id}>{t('mcp_access.create.expiry', 'Expires')}</label>
            <div className="flex flex-wrap gap-2">
                <select id={id} className={`${INPUT} w-auto`} value={choice} onChange={e => onChoice(e.target.value as ExpiryChoice)}>
                    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {choice === 'date' && (
                    <input type="date" className={`${INPUT} w-auto`} value={date} onChange={e => onDate(e.target.value)}
                        aria-label={t('mcp_access.create.expiry_date_label', 'Expiry date')} />
                )}
            </div>
            {bad && <p className="m-0 mt-1 text-[11.5px] text-[var(--error-ink)]">{t('mcp_access.create.expiry_past', 'Pick a date in the future.')}</p>}
        </div>
    );
}

/** A server the operator has not switched on is not offered at all. */
const offeredServers = (eligibility?: McpEligibility) => MCP_SERVERS.filter(s => eligibility?.[s.id]?.reason !== 'not_enabled');
const isAvailable = (eligibility: McpEligibility | undefined, id: McpServerId) => eligibility?.[id]?.available !== false;

function expiryState(choice: ExpiryChoice, date: string) {
    const expiryIso = expiryToIso(choice, date);
    return { expiryIso, expiryBad: choice === 'date' && (!expiryIso || new Date(expiryIso).getTime() <= Date.now()) };
}

function scopesFrom(servers: Record<McpServerId, ServerDraft>, publish: boolean, eligibility?: McpEligibility): McpScopes {
    const scopes: McpScopes = {};
    for (const s of MCP_SERVERS) {
        const d = servers[s.id];
        if (!d.on || !isAvailable(eligibility, s.id)) continue;
        const tools = parseToolList(d.tools);
        scopes[s.id] = {
            level: d.level,
            ...(tools.length ? { tools } : {}),
            ...(s.id === 'cms' ? { publish: d.level === 'write' && publish && eligibility?.cms?.canPublish !== false } : {}),
        };
    }
    return scopes;
}

/** The create form; once the server answers it turns into the one-time reveal of the token. */
export default function McpTokenCreateModal({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const formId = useId();
    const create = useCreateMcpToken();
    const { data: tokensData } = useMcpTokensQuery();
    const eligibility = tokensData?.eligibility;
    const offered = offeredServers(eligibility);
    const [name, setName] = useState('');
    const [servers, setServers] = useState(EMPTY_SERVERS);
    const [publish, setPublish] = useState(false);
    const [ipText, setIpText] = useState('');
    const [expiry, setExpiry] = useState<ExpiryChoice>('none');
    const [expiryDate, setExpiryDate] = useState('');
    const [tried, setTried] = useState(false);
    const [created, setCreated] = useState<McpTokenCreated | null>(null);

    const ips = useMemo(() => parseList(ipText), [ipText]);
    const badIps = useMemo(() => invalidEntries(ips), [ips]);
    const anyOn = offered.some(s => servers[s.id].on && isAvailable(eligibility, s.id));
    const { expiryIso, expiryBad } = expiryState(expiry, expiryDate);
    const nameMissing = !name.trim();
    const invalid = nameMissing || !anyOn || badIps.length > 0 || expiryBad;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        setTried(true);
        if (invalid || create.isPending) return;
        create.mutate(
            { name: name.trim(), scopes: scopesFrom(servers, publish, eligibility), ipAllowlist: ips, expiresAt: expiryIso },
            { onSuccess: setCreated },
        );
    };

    if (created) return <Reveal created={created} baseUrl={tokensData?.mcpBaseUrl} onDone={onClose} />;

    return (
        <Modal
            open
            onClose={onClose}
            size="lg"
            title={t('mcp_access.create.title', 'Create an MCP token')}
            footer={(
                <>
                    <button type="button" className={SECONDARY_BTN} onClick={onClose}>{t('mcp_access.create.cancel', 'Cancel')}</button>
                    <button type="submit" form={formId} className={PRIMARY_BTN} disabled={create.isPending}>
                        {create.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                        {t('mcp_access.create.submit', 'Create token')}
                    </button>
                </>
            )}
        >
            <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
                <div>
                    <label className={LABEL} htmlFor={`${formId}-name`}>{t('mcp_access.create.name', 'Name')}</label>
                    <input id={`${formId}-name`} className={INPUT} value={name} maxLength={80} autoComplete="off"
                        placeholder={t('mcp_access.create.name_placeholder', 'Claude Code on my laptop')}
                        onChange={e => setName(e.target.value)} />
                    {tried && nameMissing && <p className="m-0 mt-1 text-[11.5px] text-[var(--error-ink)]">{t('mcp_access.create.name_required', 'Give the token a name.')}</p>}
                </div>

                <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
                    <legend className={LABEL}>{t('mcp_access.create.servers', 'Servers')}</legend>
                    <p className={`${HINT} mt-0 mb-1`}>{t('mcp_access.create.servers_hint', 'A server you leave off cannot be reached with this token.')}</p>
                    {offered.map(s => (
                        <ServerCard key={s.id} server={s} draft={servers[s.id]} publish={publish} onPublish={setPublish} eligibility={eligibility?.[s.id]}
                            onPatch={p => setServers(all => ({ ...all, [s.id]: { ...all[s.id], ...p } }))} />
                    ))}
                    {tried && !anyOn && <p className="m-0 text-[11.5px] text-[var(--error-ink)]">{t('mcp_access.create.no_server', 'Switch on at least one server.')}</p>}
                </fieldset>

                <div>
                    <label className={LABEL} htmlFor={`${formId}-ips`}>{t('mcp_access.create.ips', 'Allowed IP addresses (optional)')}</label>
                    <textarea id={`${formId}-ips`} className={`${INPUT} font-mono`} rows={3} spellCheck={false} value={ipText}
                        placeholder={t('mcp_access.create.ips_placeholder', '203.0.113.0/24')}
                        onChange={e => setIpText(e.target.value)} />
                    <p className={HINT}>{t('mcp_access.create.ips_hint', 'One address or range (CIDR) per line. Empty means any address your organisation allows.')}</p>
                    {badIps.length > 0 && <p className="m-0 mt-1 text-[11.5px] text-[var(--error-ink)]">{t('mcp_access.ips_invalid', 'Not a valid address or range: {list}', { list: badIps.join(', ') })}</p>}
                </div>

                <ExpiryField id={`${formId}-expiry`} choice={expiry} date={expiryDate} bad={expiryBad} onChoice={setExpiry} onDate={setExpiryDate} />

                {create.isError && <div role="alert" className={ALERT_ERROR}>{create.error.message}</div>}
            </form>
        </Modal>
    );
}
