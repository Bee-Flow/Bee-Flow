import { BadgeCheck, CheckCircle2, ExternalLink, Globe, KeyRound, Loader2, PlugZap, ShieldCheck, TriangleAlert, User, Users } from 'lucide-react';
import { useId } from 'react';
import ChoiceCards from '../shared/ChoiceCards';
import SegmentedControl from '../shared/SegmentedControl';
import type { AuthStyle, CatalogEntry, McpTool } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import { toolCount } from './libraryText';
import ServerLogo from './ServerLogo';
import { ALERT_ERROR, ALERT_INFO, ALERT_SUCCESS, ALERT_WARNING, HINT, INPUT, LABEL, SECONDARY_BTN } from './ui';

export interface ConnectDraft {
    name: string;
    url: string;
    authStyle: AuthStyle;
    header: string;
    credential: string;
    credentialMode: 'shared' | 'personal';
}

interface ConnectStepProps {
    entry: CatalogEntry | null;
    draft: ConnectDraft;
    onDraft: (patch: Partial<ConnectDraft>) => void;
    onCheck: () => void;
    checking: boolean;
    checkError: string | null;
    checkedTools: McpTool[] | null;
}

/** The endpoint, the key, and whose key it is — then a live check before going on. */
export function ConnectStep({ entry, draft, onDraft, onCheck, checking, checkError, checkedTools }: ConnectStepProps) {
    const { t } = useTranslation();
    const urlId = useId();
    const nameId = useId();
    const keyId = useId();
    const headerId = useId();
    const custom = !entry;
    const editableUrl = custom || !!entry?.selfHosted;
    const needsKey = entry ? entry.authStyle !== 'none' : draft.authStyle !== 'none';
    let host: string | null = entry && !entry.selfHosted ? entry.host : null;
    if (!host && draft.url) { try { host = new URL(draft.url).hostname; } catch { host = null; } }

    return (
        <div className="flex flex-col gap-4">
            {entry && (
                <div className="flex items-start gap-3">
                    <ServerLogo server={{ id: entry.id, name: entry.name, repository: entry.repository, homepage: entry.homepage }} size={40} />
                    <div className="min-w-0">
                        <p className="m-0 text-[13px] leading-snug text-[var(--text-secondary)]">{entry.description}</p>
                        {entry.docsUrl && (
                            <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] text-[var(--accent-primary)] hover:underline">
                                {t('mcp_library.wizard.vendor_docs', 'Vendor documentation')}
                                <ExternalLink size={11} aria-hidden="true" />
                            </a>
                        )}
                    </div>
                </div>
            )}

            {custom && (
                <div>
                    <label htmlFor={nameId} className={LABEL}>{t('mcp_library.wizard.name', 'Name')}</label>
                    <input id={nameId} className={INPUT} value={draft.name} maxLength={120} onChange={e => onDraft({ name: e.target.value })}
                        placeholder={t('mcp_library.wizard.name_placeholder', 'For example: Our support desk')} />
                </div>
            )}

            {editableUrl ? (
                <div>
                    <label htmlFor={urlId} className={LABEL}>{t('mcp_library.wizard.url', 'Server address')}</label>
                    <input id={urlId} className={`${INPUT} font-mono`} value={draft.url} inputMode="url" autoComplete="off" spellCheck={false}
                        onChange={e => onDraft({ url: e.target.value })}
                        placeholder={entry?.selfHosted ? entry.url : t('mcp_library.wizard.url_example', 'https://mcp.example.com/mcp')} />
                    <p className={HINT}>{t('mcp_library.wizard.url_hint', 'The full https address of the MCP endpoint. Private and internal addresses are always blocked.')}</p>
                </div>
            ) : (
                <div className={ALERT_INFO}>
                    <Globe size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span>
                        {t('mcp_library.wizard.runs_at', 'Runs at {host}, operated by {name}. Agents send their tool requests there; nothing is installed on this server.', { host: host || '', name: entry?.name || '' })}
                        {' '}<span className="inline-flex items-center gap-1 font-medium text-[var(--success-ink)]"><BadgeCheck size={12} aria-hidden="true" />{t('mcp_library.wizard.official_endpoint', 'Official endpoint')}</span>
                    </span>
                </div>
            )}

            {custom && (
                <div className="flex flex-col gap-2">
                    <span className={LABEL}>{t('mcp_library.wizard.auth', 'How the server checks who is calling')}</span>
                    <SegmentedControl
                        size="sm"
                        value={draft.authStyle}
                        onChange={v => onDraft({ authStyle: v })}
                        ariaLabel={t('mcp_library.wizard.auth', 'How the server checks who is calling')}
                        options={[
                            { value: 'none', label: t('mcp_library.wizard.auth_none', 'No key') },
                            { value: 'bearer', label: t('mcp_library.wizard.auth_bearer', 'Bearer token') },
                            { value: 'header', label: t('mcp_library.wizard.auth_header', 'Key in a header') },
                        ]}
                    />
                    {draft.authStyle === 'header' && (
                        <div>
                            <label htmlFor={headerId} className={LABEL}>{t('mcp_library.wizard.header_name', 'Header name')}</label>
                            <input id={headerId} className={`${INPUT} font-mono`} value={draft.header} maxLength={64} onChange={e => onDraft({ header: e.target.value })} placeholder={t('mcp_library.wizard.header_example', 'X-Api-Key')} />
                        </div>
                    )}
                </div>
            )}

            {needsKey && (
                <>
                    <ChoiceCards
                        value={draft.credentialMode}
                        onChange={v => onDraft({ credentialMode: v })}
                        ariaLabel={t('mcp_library.key.whose', 'Whose key')}
                        columns={2}
                        appearance="radio"
                        options={[
                            {
                                value: 'shared',
                                label: t('mcp_library.key.shared', 'One key for everyone'),
                                description: t('mcp_library.key.shared_desc', 'Your key is used for every member. Simple, but everyone acts with its permissions.'),
                                Icon: Users,
                            },
                            {
                                value: 'personal',
                                label: t('mcp_library.key.personal', 'Everyone uses their own key'),
                                description: t('mcp_library.key.personal_desc', 'Members add their own key under Settings → Connections. Yours only checks the connection now.'),
                                Icon: User,
                            },
                        ]}
                    />
                    <div>
                        <label htmlFor={keyId} className={LABEL}>
                            {entry?.credential?.label || t('mcp_library.wizard.key', 'API key or token')}
                        </label>
                        <input id={keyId} type="password" className={`${INPUT} font-mono`} value={draft.credential} autoComplete="new-password" spellCheck={false}
                            onChange={e => onDraft({ credential: e.target.value })}
                            placeholder={t('mcp_library.wizard.key_placeholder', 'Paste the key')} />
                        <p className={HINT}>
                            {entry?.credential?.help || t('mcp_library.wizard.key_hint', 'Stored encrypted for your organisation and only ever sent to this server.')}
                            {entry?.credential?.helpUrl && (
                                <>
                                    {' '}
                                    <a href={entry.credential.helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[var(--accent-primary)] hover:underline">
                                        {t('mcp_library.wizard.create_key', 'Create one')}<ExternalLink size={10} aria-hidden="true" />
                                    </a>
                                </>
                            )}
                        </p>
                    </div>
                </>
            )}

            {entry?.safetyNote && (
                <div className={ALERT_WARNING}>
                    <ShieldCheck size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span>{entry.safetyNote}</span>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={SECONDARY_BTN} onClick={onCheck} disabled={checking}>
                    {checking ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <PlugZap size={13} aria-hidden="true" />}
                    {checking ? t('mcp_library.wizard.checking', 'Checking…') : t('mcp_library.wizard.check', 'Check connection')}
                </button>
                {checkedTools && !checking && (
                    <span role="status" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--success-ink)]">
                        <CheckCircle2 size={14} aria-hidden="true" />
                        {t('mcp_library.wizard.connected', 'Connected · {tools}', { tools: toolCount(t, checkedTools.length) })}
                    </span>
                )}
            </div>
            {checkedTools && checkedTools.length === 0 && !checking && (
                <div role="alert" className={ALERT_WARNING}>
                    <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span>{t('mcp_library.wizard.no_tools', 'The server answered but offers no tools, so there is nothing to install.')}</span>
                </div>
            )}
            {checkError && !checking && (
                <div role="alert" className={ALERT_ERROR}>
                    <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span>{checkError}</span>
                </div>
            )}
        </div>
    );
}

interface ReviewProps {
    name: string;
    host: string | null;
    official: boolean;
    needsKey: boolean;
    credentialMode: 'shared' | 'personal';
    selectedTools: number;
    accessLine: string;
}

/** The last look before anything is created: what goes where, with whose key. */
export function ReviewSummary({ name, host, official, needsKey, credentialMode, selectedTools, accessLine }: ReviewProps) {
    const { t } = useTranslation();
    const row = 'flex items-start gap-2.5 py-2';
    return (
        <div className="flex flex-col gap-3">
            <dl className="m-0 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 divide-y divide-[var(--border-subtle)]">
                <div className={row}>
                    <Globe size={14} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <dt className="sr-only">{t('mcp_library.review.server', 'Server')}</dt>
                    <dd className="m-0 text-[12.5px] text-[var(--text-primary)]">
                        <strong className="font-semibold">{name}</strong>{' · '}<span className="font-mono text-[12px]">{host}</span>
                        {official && <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--success-ink)]"><BadgeCheck size={11} aria-hidden="true" />{t('mcp_library.official', 'Official')}</span>}
                    </dd>
                </div>
                <div className={row}>
                    <KeyRound size={14} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <dt className="sr-only">{t('mcp_library.review.key', 'Key')}</dt>
                    <dd className="m-0 text-[12.5px] text-[var(--text-primary)]">
                        {!needsKey
                            ? t('mcp_library.review.no_key', 'No key: the server is public.')
                            : credentialMode === 'shared'
                                ? t('mcp_library.review.shared', 'Your key, shared with everyone who has access.')
                                : t('mcp_library.review.personal', 'Every member connects their own key.')}
                    </dd>
                </div>
                <div className={row}>
                    <PlugZap size={14} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <dt className="sr-only">{t('mcp_library.review.tools', 'Tools')}</dt>
                    <dd className="m-0 text-[12.5px] text-[var(--text-primary)]">{t('mcp_library.review.tools_on', '{tools} switched on', { tools: toolCount(t, selectedTools) })}</dd>
                </div>
                <div className={row}>
                    <Users size={14} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <dt className="sr-only">{t('mcp_library.review.access', 'Who can use it')}</dt>
                    <dd className="m-0 text-[12.5px] text-[var(--text-primary)]">{accessLine}</dd>
                </div>
            </dl>
            <div className={ALERT_SUCCESS}>
                <ShieldCheck size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>{t('mcp_library.review.safety', 'Bee Flow never runs this server\'s code. Agents only call it when a member uses them, keys stay encrypted, and new tools the server adds later stay off until you switch them on. Not yet available in automations.')}</span>
            </div>
        </div>
    );
}
