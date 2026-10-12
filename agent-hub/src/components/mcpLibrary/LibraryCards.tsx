import { BadgeCheck, Globe, KeyRound, Lock, Plus, Server, Users } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';
import type { CatalogEntry, InstalledServer, ServerWideServer } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import { accessSummary, categoryLabel, toolCount } from './libraryText';
import ServerLogo from './ServerLogo';
import { CARD, CARD_BUTTON, CHIP, CHIP_SUCCESS, CHIP_WARNING, DOT_LIVE, DOT_OFF, DOT_WARN, PRIMARY_BTN, SECONDARY_BTN } from './ui';

function StatusWord({ tone, children }: { tone: 'live' | 'off' | 'warn'; children: ReactNode }) {
    const dot = tone === 'live' ? DOT_LIVE : tone === 'warn' ? DOT_WARN : DOT_OFF;
    const ink = tone === 'live' ? 'text-[var(--success-ink)]' : tone === 'warn' ? 'text-[var(--warning-ink)]' : 'text-[var(--text-secondary)]';
    return (
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${ink}`}>
            <span className={dot} aria-hidden="true" />
            {children}
        </span>
    );
}

export function InstalledStatus({ server }: { server: InstalledServer }) {
    const { t } = useTranslation();
    if (server.blockedByPolicy) return <StatusWord tone="warn">{t('mcp_library.status.blocked', 'Blocked by policy')}</StatusWord>;
    if (server.status === 'active') return <StatusWord tone="live">{t('mcp_library.status.running', 'Running')}</StatusWord>;
    if (server.status === 'draft') return <StatusWord tone="warn">{t('mcp_library.status.unfinished', 'Unfinished')}</StatusWord>;
    return <StatusWord tone="off">{t('mcp_library.status.off', 'Off')}</StatusWord>;
}

export function InstalledCard({ server, catalog, onOpen }: { server: InstalledServer; catalog?: CatalogEntry | null; onOpen: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" className={CARD_BUTTON} onClick={onOpen} aria-label={t('mcp_library.card.open', 'Open {name}', { name: server.name })}>
            <div className="flex items-start gap-3 w-full">
                <ServerLogo server={{ id: server.catalogId, name: server.name, repository: catalog?.repository, homepage: catalog?.homepage }} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold leading-snug text-[var(--text-primary)] truncate">{server.name}</span>
                        {server.official && <BadgeCheck size={13} className="flex-shrink-0 text-[var(--success)]" aria-label={t('mcp_library.official', 'Official')} />}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)] truncate">{server.host}</div>
                </div>
                <InstalledStatus server={server} />
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-1.5 w-full">
                <span className={CHIP}>{toolCount(t, server.enabledToolCount)}</span>
                <span className={CHIP}><Users size={11} aria-hidden="true" />{accessSummary(t, server.access)}</span>
                {server.credentialMode === 'shared' && <span className={CHIP}><KeyRound size={11} aria-hidden="true" />{t('mcp_library.key.shared_short', 'Shared key')}</span>}
                {server.credentialMode === 'personal' && <span className={CHIP}><KeyRound size={11} aria-hidden="true" />{t('mcp_library.key.personal_short', 'Own keys')}</span>}
            </div>
        </button>
    );
}

export function ServerWideCard({ server, onOpen }: { server: ServerWideServer; onOpen: () => void }) {
    const { t } = useTranslation();
    const inUse = server.access.mode !== 'nobody';
    return (
        <button type="button" className={CARD_BUTTON} onClick={onOpen} aria-label={t('mcp_library.card.open', 'Open {name}', { name: server.name })}>
            <div className="flex items-start gap-3 w-full">
                <ServerLogo server={{ id: server.id, name: server.name, icon: server.icon }} />
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold leading-snug text-[var(--text-primary)] truncate">{server.name}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-tertiary)] line-clamp-2">{server.description}</div>
                </div>
                {!server.available
                    ? <StatusWord tone="off">{t('mcp_library.status.not_in_plan', 'Not in plan')}</StatusWord>
                    : inUse
                        ? <StatusWord tone="live">{t('mcp_library.status.in_use', 'In use')}</StatusWord>
                        : <StatusWord tone="off">{t('mcp_library.status.off', 'Off')}</StatusWord>}
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-1.5 w-full">
                <span className={CHIP}>{toolCount(t, server.toolCount)}</span>
                {inUse && <span className={CHIP}><Users size={11} aria-hidden="true" />{accessSummary(t, server.access)}</span>}
                <span className={CHIP}>
                    {server.runsOn === 'server'
                        ? <><Server size={11} aria-hidden="true" />{t('mcp_library.runs_on.server', 'Runs on this server')}</>
                        : <><Globe size={11} aria-hidden="true" />{t('mcp_library.runs_on.remote', 'Remote')}</>}
                </span>
            </div>
        </button>
    );
}

export function CatalogCard({ entry, onAdd, lockedReason }: { entry: CatalogEntry; onAdd: () => void; lockedReason: string | null }) {
    const { t } = useTranslation();
    const titleId = useId();
    const installed = entry.installedIds.length > 0;
    return (
        <div className={CARD}>
            <div className="flex items-start gap-3">
                <ServerLogo server={{ id: entry.id, name: entry.name, repository: entry.repository, homepage: entry.homepage }} />
                <div className="min-w-0 flex-1">
                    <h4 id={titleId} className="m-0 flex items-center gap-1.5 text-[13px] font-semibold leading-snug text-[var(--text-primary)]">
                        <span className="truncate">{entry.name}</span>
                        {!entry.selfHosted && <BadgeCheck size={13} className="flex-shrink-0 text-[var(--success)]" aria-label={t('mcp_library.official', 'Official')} />}
                    </h4>
                    <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-2">{entry.description}</p>
                </div>
            </div>
            <div className="mt-auto flex items-end gap-3">
                <div className="flex-1 min-w-0 flex flex-wrap gap-1.5">
                    <span className={CHIP}>{categoryLabel(t, entry.category)}</span>
                    {entry.authStyle === 'none'
                        ? <span className={CHIP_SUCCESS}>{t('mcp_library.card.no_key', 'No key needed')}</span>
                        : <span className={CHIP}><KeyRound size={11} aria-hidden="true" />{t('mcp_library.card.needs_key', 'Needs a key')}</span>}
                    {entry.selfHosted && <span className={CHIP_WARNING}>{t('mcp_library.card.self_hosted', 'Your own instance')}</span>}
                </div>
                {lockedReason ? (
                    <span className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]" title={lockedReason}>
                        <Lock size={12} aria-hidden="true" />
                        {t('mcp_library.card.locked', 'Not allowed')}
                    </span>
                ) : (
                    <button type="button" aria-describedby={titleId} className={installed ? SECONDARY_BTN : PRIMARY_BTN} onClick={onAdd}>
                        <Plus size={13} aria-hidden="true" />
                        {installed ? t('mcp_library.card.add_again', 'Add again') : t('mcp_library.card.add', 'Add')}
                    </button>
                )}
            </div>
        </div>
    );
}

export function CustomServerCard({ onAdd }: { onAdd: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onAdd}
            className="flex flex-col items-start gap-2 p-3.5 rounded-[10px] border border-dashed border-[var(--border-default)] text-left transition hover:bg-[var(--bg-secondary)] hover:border-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
        >
            <span className="w-8 h-8 rounded-lg grid place-items-center bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <Plus size={16} aria-hidden="true" />
            </span>
            <span className="text-[13px] font-semibold text-[var(--text-primary)]">{t('mcp_library.custom.title', 'Connect another server')}</span>
            <span className="text-[12px] leading-snug text-[var(--text-tertiary)]">{t('mcp_library.custom.desc', 'Any remote MCP server your server administrator allows, by its https address.')}</span>
        </button>
    );
}
