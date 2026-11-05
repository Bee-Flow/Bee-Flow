/**
 * The Adoption report as CSV, built on the client from what is on screen.
 *
 * Every section is an explicit column list, never a dump of the row objects:
 * a field the server adds next year does not leak into a file someone mails
 * around. The people section carries a member's NAME only when the names were
 * revealed on screen (the reveal is what wrote the access-audit row); without
 * a reveal it carries the pseudonym, and a revealed answer that somehow sits
 * behind a hidden screen is written as pseudonyms-or-nothing, never as names.
 */
import { rowsToCsv } from '@/utils/usageHelpers';
import type {
    AdoptionAreas, AdoptionGroups, AdoptionPeopleView, AdoptionStudio, AdoptionStudioItems, AdoptionSummary,
} from './adoption.types';
import { foldAreas } from './AreasSection';

export interface AdoptionExport {
    summary: AdoptionSummary | null;
    areas: AdoptionAreas | null;
    studio: AdoptionStudio | null;
    groups: AdoptionGroups | null;
    people: AdoptionPeopleView | null;
    /** Whether the screen shows names right now. */
    revealed: boolean;
}

const num = (n: number | null | undefined) => (n == null ? '' : Number(n));

function section(title: string, headers: string[], rows: Array<Record<string, unknown>>): string {
    return `# ${title}\n${rowsToCsv(headers, rows)}`;
}

function periodSection(s: AdoptionSummary): string {
    return section('period', ['start_date', 'end_date', 'members', 'ai_active', 'adoption_rate_pct', 'makers', 'ai_cost'], [{
        start_date: s.range.startDate, end_date: s.range.endDate, members: s.members.total, ai_active: s.members.aiActive,
        adoption_rate_pct: Math.round(s.adoptionRate), makers: s.makers.total, ai_cost: s.spend.cost,
    }]);
}

function areasSection(a: AdoptionAreas): string {
    const rows = foldAreas(a.areas || []).map(r => ({ area: r.id, folded_areas: r.folded.join(' '), people: r.people, calls: num(r.calls), ai_cost: r.cost }));
    return section('areas', ['area', 'folded_areas', 'people', 'calls', 'ai_cost'], rows);
}

function studioSection(st: AdoptionStudio): string {
    const rows = (st.kinds || []).filter(k => k.total > 0).map(k => ({
        kind: k.kind, total: k.total, published: k.published, makers: k.makers, new_in_period: k.newInPeriod,
        people_using: k.usage ? k.usage.people : 'no signal', uses: k.usage ? k.usage.events : 'no signal',
        uses_what: k.usage ? k.usage.label : '', ai_cost: num(k.cost), delta_pct: num(k.deltaPct),
    }));
    return section('studio', ['kind', 'total', 'published', 'makers', 'new_in_period', 'people_using', 'uses', 'uses_what', 'ai_cost', 'delta_pct'], rows);
}

function groupsSection(g: AdoptionGroups): string {
    const rows: Array<Record<string, unknown>> = (g.groups || []).map(r => ({
        group: r.name, source: r.source, members: r.members, ai_active: r.aiActive, adoption_rate_pct: Math.round(r.adoptionRate),
        makers: r.makers, ai_cost: r.cost, top_area: r.topArea ?? '',
    }));
    if (g.folded) {
        rows.push({
            group: `other groups (${g.folded.count})`, source: '', members: g.folded.members, ai_active: g.folded.aiActive,
            adoption_rate_pct: Math.round(g.folded.adoptionRate), makers: g.folded.makers, ai_cost: g.folded.cost, top_area: g.folded.topArea ?? '',
        });
    }
    return section('groups', ['group', 'source', 'members', 'ai_active', 'adoption_rate_pct', 'makers', 'ai_cost', 'top_area'], rows);
}

function peopleSection(p: AdoptionPeopleView, revealed: boolean): string {
    const showNames = revealed && p.reveal;
    const rows = p.people.map(m => ({
        // A revealed answer behind a hidden screen has no pseudonym to fall back to.
        member: showNames || !p.reveal ? m.name : '',
        role: m.role, groups: (m.groups || []).join('; '), status: m.status, last_seen_at: m.lastSeenAt ?? '',
        calls: num(m.calls), ai_cost: m.cost, areas: (m.areas || []).join(' '),
        built: Object.entries(m.built || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' '),
        first_ai_use_at: m.firstAiUseAt ?? '',
    }));
    return section(showNames ? 'people (names revealed, recorded in the access audit log)' : 'people (pseudonymous)',
        ['member', 'role', 'groups', 'status', 'last_seen_at', 'calls', 'ai_cost', 'areas', 'built', 'first_ai_use_at'], rows);
}

/** One CSV with a section per table (`# title` line, then the header and rows). */
export function adoptionCsv(x: AdoptionExport): string {
    const parts: string[] = [];
    if (x.summary) parts.push(periodSection(x.summary));
    if (x.areas) parts.push(areasSection(x.areas));
    if (x.studio) parts.push(studioSection(x.studio));
    if (x.groups) parts.push(groupsSection(x.groups));
    if (x.people) parts.push(peopleSection(x.people, x.revealed));
    return parts.join('\n\n');
}

/** The items of one Studio kind (names of objects and their makers: organisational metadata). */
export function itemsCsv(d: AdoptionStudioItems): string {
    const rows = d.items.map(i => ({
        name: i.name, owner: i.ownerName, audience: i.audience, created_at: i.createdAt, last_used_at: i.lastUsedAt ?? '',
        people: num(i.people), uses: num(i.uses), ai_cost: num(i.cost),
    }));
    return rowsToCsv(['name', 'owner', 'audience', 'created_at', 'last_used_at', 'people', 'uses', 'ai_cost'], rows);
}
