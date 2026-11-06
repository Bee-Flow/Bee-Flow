import { Eye, EyeOff, Search, ShieldAlert, User } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card, EmptyInline, SectionTitle, ShowMore } from '../kit';
import { Avatar } from '../widgets';
import type { AdoptionPeopleView, AdoptionPerson, PersonStatus } from './adoption.types';
import { areaMeta } from './areaMeta';
import { daysSince, fAgo, fInt, fMoney } from './format';
import { kindMeta } from './kindMeta';
import { PeopleBanner } from './PeopleBanner';

type T = ReturnType<typeof useTranslation>['t'];
type SortKey = 'cost' | 'seen' | 'built' | 'name';

const PAGE = 25;

export interface PeopleTableProps {
    view: AdoptionPeopleView | null;
    loading: boolean;
    revealed: boolean;
    /** The reveal was refused because the access audit log could not record it. */
    auditFailed: boolean;
    /** When the revealed answer arrived (epoch ms), for the banner. */
    revealedAt: number | null;
    scopeLabel: string;
    currency: string;
    showCalls: boolean;
    hasMore: boolean;
    onLoadMore: () => void;
    onReveal: () => void;
    onHide: () => void;
}

function statusLabel(s: PersonStatus, t: T): string {
    if (s === 'ai_active') return t('adoption.status_ai_active', 'AI-active');
    if (s === 'seen_only') return t('adoption.status_seen_only', 'Signed in only');
    if (s === 'dormant') return t('adoption.status_dormant', 'Dormant > 30 d');
    if (s === 'never') return t('adoption.status_never', 'Never signed in');
    return '—';
}

/** The built-in org roles (server/config/orgRoles.json) and their names. */
const ROLE_NAMES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
    org_admin: ['adoption.role_org_admin', 'Organisation admin'],
    dpo: ['adoption.role_dpo', 'Data protection officer'],
    isms_auditor: ['adoption.role_isms_auditor', 'ISMS auditor'],
    agent_admin: ['adoption.role_agent_admin', 'Agent admin'],
    agent_editor: ['adoption.role_agent_editor', 'Agent editor'],
    member: ['adoption.role_member', 'Member'],
});

/** An org role id as its name; a custom role keeps its id. */
function roleLabel(role: string, t: T): string {
    const entry = Object.hasOwn(ROLE_NAMES, role) ? ROLE_NAMES[role] : undefined;
    if (entry) return t(entry[0], entry[1]);
    return role || '—';
}

const builtCount = (p: AdoptionPerson) => Object.values(p.built || {}).reduce((s, n) => s + (Number(n) || 0), 0);

function sortPeople(list: AdoptionPerson[], key: SortKey): AdoptionPerson[] {
    const out = [...list];
    if (key === 'cost') out.sort((a, b) => b.cost - a.cost);
    if (key === 'seen') out.sort((a, b) => (a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0) - (b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0));
    if (key === 'built') out.sort((a, b) => builtCount(b) - builtCount(a));
    if (key === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

function builtLine(p: AdoptionPerson, t: T): string {
    const parts = Object.entries(p.built || {}).filter(([, n]) => n > 0).map(([k, n]) => `${fInt(n)} ${kindMeta(k, t).label}`);
    return parts.length ? parts.join(' · ') : '—';
}

function PersonRow({ p, revealed, currency, showCalls }: { p: AdoptionPerson; revealed: boolean; currency: string; showCalls: boolean }) {
    const { t } = useTranslation();
    const stale = (daysSince(p.lastSeenAt) ?? 0) > 30 || p.status === 'never' || p.status === 'dormant';
    const cell = 'px-3 py-2 text-right tabular-nums text-[12px] text-[var(--text-primary)]';
    return (
        <tr className="border-b border-[var(--border-subtle)] last:border-b-0">
            <th scope="row" className="px-3 py-2 text-left font-normal">
                <span className="flex items-center gap-2">
                    {revealed
                        ? <Avatar user={{ display_name: p.name, avatarType: p.avatarType, avatar: p.avatar }} color="var(--chart-1)" size={24} />
                        : <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]" aria-hidden="true"><User className="h-3 w-3" /></span>}
                    <span className="text-[12px] font-semibold text-[var(--text-primary)]">{p.name}</span>
                </span>
            </th>
            <td className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">{roleLabel(p.role, t)}</td>
            <td className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">{(p.groups || []).join(', ') || '—'}</td>
            <td className="px-3 py-2 text-[11px]">
                <span className={stale ? 'text-[var(--warning,#b45309)]' : 'text-[var(--text-secondary)]'}>{fAgo(p.lastSeenAt, t)}</span>
                <span className="block text-[10px] text-[var(--text-muted)]">{statusLabel(p.status, t)}</span>
            </td>
            {showCalls && <td className={cell}>{fInt(p.calls)}</td>}
            <td className={cell}>{fMoney(p.cost, currency)}</td>
            <td className="px-3 py-2"><span className="flex flex-wrap gap-1">{(p.areas || []).map(a => {
                const m = areaMeta(a, t);
                return <span key={a} className="inline-flex items-center gap-1 rounded-md bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]"><span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} aria-hidden="true" />{m.label}</span>;
            })}</span></td>
            <td className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">{builtLine(p, t)}</td>
        </tr>
    );
}

interface ControlsProps {
    query: string; setQuery: (v: string) => void;
    sort: SortKey; setSort: (v: SortKey) => void;
    inactiveOnly: boolean; setInactiveOnly: (v: boolean) => void;
    inactiveCount: number;
}

function PeopleControls({ query, setQuery, sort, setSort, inactiveOnly, setInactiveOnly, inactiveCount }: ControlsProps) {
    const { t } = useTranslation();
    return (
        <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="relative">
                <span className="sr-only">{t('adoption.people_search', 'Search people')}</span>
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('adoption.people_search', 'Search people')}
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] py-1.5 pl-7 pr-2 text-[12px] text-[var(--text-primary)]" />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                {t('adoption.people_sort', 'Sort')}
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)]">
                    <option value="cost">{t('adoption.people_sort_cost', 'AI cost, high to low')}</option>
                    <option value="seen">{t('adoption.people_sort_seen', 'Last seen, oldest first')}</option>
                    <option value="built">{t('adoption.people_sort_built', 'Things built')}</option>
                    <option value="name">{t('adoption.people_sort_name', 'Name')}</option>
                </select>
            </label>
            <button type="button" aria-pressed={inactiveOnly} onClick={() => setInactiveOnly(!inactiveOnly)}
                className={`rounded-lg border px-2.5 py-1.5 text-[12px] ${inactiveOnly ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>
                {t('adoption.people_inactive', 'Not yet active · {n}', { n: fInt(inactiveCount) })}
            </button>
        </div>
    );
}

function headers(showCalls: boolean, t: T): string[] {
    return [
        t('adoption.people_col_member', 'Member'), t('adoption.people_col_role', 'Role'), t('adoption.people_col_groups', 'Groups'),
        t('adoption.people_col_seen', 'Last seen'), ...(showCalls ? [t('adoption.people_col_calls', 'AI calls')] : []),
        t('adoption.people_col_cost', 'AI cost'), t('adoption.people_col_areas', 'Areas used'), t('adoption.people_col_built', 'Built'),
    ];
}

function PeopleRows({ rows, props }: { rows: AdoptionPerson[]; props: PeopleTableProps }) {
    const { t } = useTranslation();
    const cols = headers(props.showCalls, t);
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse bg-[var(--bg-primary)]">
                <thead><tr className="border-b border-[var(--border-subtle)]">{cols.map(c => (
                    <th key={c} scope="col" className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">{c}</th>
                ))}</tr></thead>
                <tbody>{rows.map(p => <PersonRow key={p.id} p={p} revealed={props.revealed && !!props.view?.reveal} currency={props.currency} showCalls={props.showCalls} />)}</tbody>
            </table>
        </div>
    );
}

function visibleRows(list: AdoptionPerson[], query: string, sort: SortKey): AdoptionPerson[] {
    const q = query.trim().toLowerCase();
    const hit = (p: AdoptionPerson) => !q || p.name.toLowerCase().includes(q) || (p.groups || []).some(g => g.toLowerCase().includes(q));
    return sortPeople(list.filter(hit), sort);
}

function PeopleBody({ rows, shown, onMore, props }: { rows: AdoptionPerson[]; shown: number; onMore: () => void; props: PeopleTableProps }) {
    const { t } = useTranslation();
    if (props.auditFailed) return <EmptyInline icon={ShieldAlert} text={t('adoption.people_nothing_shown', 'Nothing is shown.')} />;
    if (rows.length === 0) return <EmptyInline text={props.loading ? t('adoption.loading', 'Loading…') : t('adoption.people_empty', 'No members match.')} />;
    const hidden = Math.max(0, rows.length - shown);
    return (
        <>
            <PeopleRows rows={rows.slice(0, shown)} props={props} />
            {(hidden > 0 || props.hasMore) && <ShowMore onMore={onMore} label={t('adoption.show_more', 'Show more ({n} remaining)', { n: hidden })} />}
        </>
    );
}

/** The people answer as it may be shown: none while hidden if it carries names. */
export function shownView(view: AdoptionPeopleView | null, revealed: boolean): AdoptionPeopleView | null {
    return !revealed && view?.reveal ? null : view;
}

/**
 * Adoption per person. Rows are pseudonymous until the admin reveals the
 * names (one click, recorded in the access audit log by the server before it
 * answers); a reveal the log could not record shows nothing at all.
 */
export default function PeopleTable(given: PeopleTableProps) {
    const { t } = useTranslation();
    const props = { ...given, view: shownView(given.view, given.revealed) };
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<SortKey>('cost');
    const [inactiveOnly, setInactiveOnly] = useState(false);
    const [shown, setShown] = useState(PAGE);
    const all = props.auditFailed ? [] : (props.view?.people || []);
    const inactive = all.filter(p => p.status !== 'ai_active');
    const rows = visibleRows(inactiveOnly ? inactive : all, query, sort);
    const more = () => { setShown(n => n + PAGE); if (shown + PAGE >= rows.length && props.hasMore) props.onLoadMore(); };
    return (
        <div>
            <SectionTitle icon={props.revealed ? Eye : EyeOff}>
                {t('adoption.people_title', 'People')}
                <span className="ml-2 text-[11px] font-normal text-[var(--text-muted)]">{fInt(props.view?.total ?? all.length)}</span>
            </SectionTitle>
            <PeopleBanner {...props} />
            {!props.auditFailed && <PeopleControls query={query} setQuery={setQuery} sort={sort} setSort={setSort} inactiveOnly={inactiveOnly} setInactiveOnly={setInactiveOnly} inactiveCount={inactive.length} />}
            <Card><PeopleBody rows={rows} shown={shown} onMore={more} props={props} /></Card>
        </div>
    );
}
