import { UsersRound } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card, EmptyInline, SectionTitle } from '../kit';
import type { AdoptionGroups } from './adoption.types';
import { areaMeta } from './areaMeta';
import { fInt, fMoney } from './format';

type T = ReturnType<typeof useTranslation>['t'];

/** One rendered row: a group, or the folded "Other groups". */
interface GroupLine {
    key: string;
    name: string;
    sub: string;
    members: number;
    aiActive: number | null;
    adoptionRate: number | null;
    makers: number | null;
    cost: number | null;
    topArea: string | null;
}

function sourceLabel(source: string, t: T): string {
    if (source === 'entra') return t('adoption.groups_src_entra', 'Entra ID');
    if (source === 'nextcloud') return t('adoption.groups_src_nextcloud', 'Nextcloud');
    return t('adoption.groups_src_local', 'Bee Flow');
}

function linesOf(data: AdoptionGroups, t: T): GroupLine[] {
    const lines: GroupLine[] = (data.groups || []).map(g => ({
        key: g.id, name: g.name, sub: sourceLabel(g.source, t), members: g.members, aiActive: g.aiActive,
        adoptionRate: g.adoptionRate, makers: g.makers, cost: g.cost, topArea: g.topArea,
    }));
    if (data.folded) {
        const f = data.folded;
        lines.push({
            key: '__folded', name: t('adoption.groups_folded', 'Other groups ({n})', { n: f.count }),
            // A merged set that is itself under five people shows its size only.
            sub: f.aiActive == null
                ? t('adoption.groups_folded_withheld', 'fewer than 5 members in total · figures withheld')
                : t('adoption.groups_folded_sub', 'fewer than 5 members each'),
            members: f.members, aiActive: f.aiActive,
            adoptionRate: f.adoptionRate, makers: f.makers, cost: f.cost, topArea: f.topArea,
        });
    }
    return lines;
}

function AreaCell({ area }: { area: string | null }) {
    const { t } = useTranslation();
    if (!area) return <span className="text-[var(--text-muted)]">—</span>;
    const m = areaMeta(area, t);
    return (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: m.color }} aria-hidden="true" />
            {m.label}
        </span>
    );
}

function GroupRow({ g, currency }: { g: GroupLine; currency: string }) {
    const cell = 'px-3 py-2.5 text-right tabular-nums text-[12px] text-[var(--text-primary)]';
    const pct = g.adoptionRate == null ? null : Math.round(g.adoptionRate);
    const dash = <span className="text-[var(--text-muted)]">—</span>;
    return (
        <tr className="border-b border-[var(--border-subtle)] last:border-b-0">
            <th scope="row" className="px-3 py-2.5 text-left font-normal">
                <span className="block text-[12px] font-semibold text-[var(--text-primary)]">{g.name}</span>
                <span className="block text-[10px] text-[var(--text-muted)]">{g.sub}</span>
            </th>
            <td className={cell}>{fInt(g.members)}</td>
            <td className={cell}>{g.aiActive == null ? dash : fInt(g.aiActive)}</td>
            <td className="px-3 py-2.5">
                {pct == null ? dash : (
                    <span className="flex items-center gap-2">
                        <span className="h-2 w-24 overflow-hidden rounded-full bg-[var(--bg-tertiary)]" aria-hidden="true">
                            <span className="block h-full rounded-full bg-[var(--chart-3)]" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                        </span>
                        <span className="text-[12px] tabular-nums text-[var(--text-primary)]">{`${pct}%`}</span>
                    </span>
                )}
            </td>
            <td className={cell}>{g.makers == null ? dash : fInt(g.makers)}</td>
            <td className={cell}>{g.cost == null ? dash : fMoney(g.cost, currency)}</td>
            <td className="px-3 py-2.5"><AreaCell area={g.topArea} /></td>
        </tr>
    );
}

/**
 * Adoption per group: members, how many used AI, makers, spend and the area
 * used most. Groups with fewer than five members arrive folded into one
 * "Other groups" row, so no small group can be read as a few people.
 */
export default function GroupsTable({ data, currency }: { data: AdoptionGroups; currency: string }) {
    const { t } = useTranslation();
    const lines = linesOf(data, t);
    const cols = [
        t('adoption.groups_col_group', 'Group'), t('adoption.groups_col_members', 'Members'), t('adoption.groups_col_active', 'AI-active'),
        t('adoption.groups_col_rate', 'Adoption'), t('adoption.groups_col_makers', 'Makers'), t('adoption.groups_col_cost', 'AI cost'),
        t('adoption.groups_col_area', 'Most used area'),
    ];
    return (
        <div>
            <SectionTitle icon={UsersRound} right={<span className="text-[11px] text-[var(--text-muted)]">{t('adoption.groups_fold_note', 'groups with fewer than 5 members are folded into “Other groups”')}</span>}>
                {t('adoption.groups_title', 'Adoption by group')}
            </SectionTitle>
            <Card>
                {lines.length === 0 ? <EmptyInline text={t('adoption.groups_empty', 'No groups in this organisation yet.')} /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse bg-[var(--bg-primary)]">
                            <thead><tr className="border-b border-[var(--border-subtle)]">{cols.map((c, i) => (
                                <th key={c} scope="col" className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] ${i === 0 || i >= 6 || i === 3 ? 'text-left' : 'text-right'}`}>{c}</th>
                            ))}</tr></thead>
                            <tbody>{lines.map(g => <GroupRow key={g.key} g={g} currency={currency} />)}</tbody>
                        </table>
                    </div>
                )}
            </Card>
        </div>
    );
}
