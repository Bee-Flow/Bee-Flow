import { BadgeCheck, Check, ExternalLink, Globe, KeyRound, Loader2, Plus, Server } from 'lucide-react';
import { useId, useState } from 'react';
import type { ServerMcpCandidate } from '../../../api/queries/serverMcp';
import { useTranslation } from '../../../hooks/useTranslation';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import ServerLogo from '../ServerLogo';
import { CHIP, CHIP_SUCCESS, INPUT, PRIMARY_BTN, QUIET_BTN, SECONDARY_BTN } from '../ui';

interface CandidateRowProps {
    candidate: ServerMcpCandidate;
    installed: boolean;
    busy: boolean;
    disabled: boolean;
    onInstall: (candidate: ServerMcpCandidate, url?: string) => void;
}

/**
 * One installable server in the server administrator's install dialog. The
 * exact command (or address) is always on screen: for a local server that
 * line is the program this server is about to download and run.
 */
export default function CandidateRow({ candidate, installed, busy, disabled, onInstall }: CandidateRowProps) {
    const { t } = useTranslation();
    const urlId = useId();
    const [asking, setAsking] = useState(false);
    const [url, setUrl] = useState(candidate.url || '');
    const local = candidate.transport !== 'http';
    const runs = local ? [candidate.command, ...(candidate.args || [])].filter(Boolean).join(' ') : (candidate.url || '');
    const creds = candidate.required_credentials || [];

    return (
        <li className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-start gap-3">
                <ServerLogo server={{ id: candidate.id, name: candidate.name, repository: candidate.repository, homepage: candidate.homepage, icon: candidate.icon }} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{candidate.name}</span>
                        {candidate.verified && <BadgeCheck size={13} className="flex-shrink-0 text-[var(--success)]" aria-label={t('mcp_library.official', 'Official')} />}
                    </div>
                    {candidate.description && <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-2">{candidate.description}</p>}
                    <code className="mt-1 block text-[11px] text-[var(--text-tertiary)] break-all">{runs}</code>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <span className={CHIP}>
                            {local
                                ? <><Server size={11} aria-hidden="true" />{t('mcp_library.runs_on.server', 'Runs on this server')}</>
                                : <><Globe size={11} aria-hidden="true" />{t('mcp_library.runs_on.remote', 'Remote')}</>}
                        </span>
                        {creds.length > 0 && (
                            <span className={CHIP}><KeyRound size={11} aria-hidden="true" />{nOf(t, 'mcp_library.server.n_member_keys', creds.length, '{count} key per member', '{count} keys per member')}</span>
                        )}
                    </div>
                </div>
                <div className="flex-shrink-0">
                    {installed ? (
                        <span className={CHIP_SUCCESS}><Check size={11} aria-hidden="true" />{t('mcp_library.server.installed_badge', 'Installed')}</span>
                    ) : candidate.viewOnly ? (
                        <a href={candidate.homepage || candidate.repository || '#'} target="_blank" rel="noopener noreferrer" className={QUIET_BTN}>
                            {t('mcp_library.server.view_source', 'Source')}<ExternalLink size={11} aria-hidden="true" />
                        </a>
                    ) : (
                        <button type="button" className={PRIMARY_BTN} disabled={busy || disabled}
                            onClick={() => (candidate.configurable_url ? setAsking(true) : onInstall(candidate))}>
                            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
                            {t('mcp_library.server.install_one', 'Install')}
                        </button>
                    )}
                </div>
            </div>
            {asking && (
                <div className="flex flex-col gap-2 pl-11">
                    <label htmlFor={urlId} className="text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp_library.server.instance_url', 'Your instance\'s MCP address')}</label>
                    <input id={urlId} className={`${INPUT} font-mono`} value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} />
                    <div className="flex gap-2">
                        <button type="button" className={PRIMARY_BTN} disabled={!url.trim() || busy} onClick={() => onInstall(candidate, url.trim())}>
                            {t('mcp_library.server.install_one', 'Install')}
                        </button>
                        <button type="button" className={SECONDARY_BTN} onClick={() => setAsking(false)}>{t('mcp_library.drawer.cancel', 'Cancel')}</button>
                    </div>
                </div>
            )}
        </li>
    );
}
