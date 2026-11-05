// @vitest-environment node
/**
 * The Adoption demo fixtures: the contract's field names, numbers that add up
 * across the routes (hero, areas, groups, people), and people that are
 * pseudonymous unless the request asks for `reveal=true`.
 */
import { describe, expect, it } from 'vitest';
import { createState, ROUTES } from './monitoring';

type Handler = (ctx: { state: ReturnType<typeof createState>; query: URLSearchParams }) => unknown;
const call = <T>(route: string, query = '') => (ROUTES as unknown as Record<string, Handler>)[route]({ state: createState(), query: new URLSearchParams(query) }) as T;

interface Summary { members: { total: number; aiActive: number; seenOnly: number | null }; spend: { cost: number; calls: number }; makers: { total: number }; range: { relative: boolean } }
interface Areas { areas: Array<{ area: string; cost: number; calls: number; sources: Array<{ cost: number }> }>; timeline: { weeks: Array<{ total: number; complete: boolean; byArea: Record<string, number> }> } }
interface Groups { groups: Array<{ members: number; aiActive: number; cost: number; makers: number }>; folded: { members: number; aiActive: number; cost: number; makers: number } }
interface People { reveal: boolean; auditRecorded: boolean; people: Array<{ id: string; name: string; status: string; cost: number }>; total: number; nextCursor: number | null }

describe('adoption fixtures', () => {
    it('the areas sum to the hero spend, and every week has every area', () => {
        const s = call<Summary>('GET /api/usage/adoption/summary', 'days=30');
        const a = call<Areas>('GET /api/usage/adoption/areas', 'days=30');
        expect(a.areas.reduce((x, r) => x + r.cost, 0)).toBe(s.spend.cost);
        expect(a.areas.reduce((x, r) => x + r.calls, 0)).toBe(s.spend.calls);
        const ids = a.areas.map(r => r.area);
        for (const w of a.timeline.weeks) expect(Object.keys(w.byArea).sort()).toEqual([...ids].sort());
        expect(a.timeline.weeks.filter(w => !w.complete)).toHaveLength(1);
        const weekly = a.timeline.weeks.reduce((x, w) => x + w.total, 0);
        expect(Math.abs(weekly - s.spend.cost)).toBeLessThan(1);
    });

    it('the groups (folded included) add up to the members, AI-active members, makers and spend', () => {
        const s = call<Summary>('GET /api/usage/adoption/summary', 'days=30');
        const g = call<Groups>('GET /api/usage/adoption/groups', 'days=30');
        const rows = [...g.groups, g.folded];
        expect(rows.reduce((x, r) => x + r.members, 0)).toBe(s.members.total);
        expect(rows.reduce((x, r) => x + r.aiActive, 0)).toBe(s.members.aiActive);
        expect(rows.reduce((x, r) => x + r.makers, 0)).toBe(s.makers.total);
        expect(rows.reduce((x, r) => x + r.cost, 0)).toBe(s.spend.cost);
    });

    it('an absolute window has no seen/dormant figures', () => {
        const s = call<Summary>('GET /api/usage/adoption/summary', 'startDate=2026-10-01&endDate=2026-10-31');
        expect(s.range.relative).toBe(false);
        expect(s.members.seenOnly).toBeNull();
    });

    it('people are pseudonymous by default: stable, distinct, from the 32-symbol alphabet', () => {
        const p = call<People>('GET /api/usage/adoption/people', 'days=30&limit=200');
        expect(p.reveal).toBe(false);
        expect(p.auditRecorded).toBe(false);
        expect(p.total).toBe(148);
        expect(p.people).toHaveLength(148);
        for (const m of p.people) {
            expect(m.name).toMatch(/^Member · [A-HJ-NP-Z2-9]{4}$/);
            expect(m.id).toBe(m.name);
        }
        expect(new Set(p.people.map(m => m.name)).size).toBe(148);
        const again = call<People>('GET /api/usage/adoption/people', 'days=30&limit=200');
        expect(again.people.map(m => m.name)).toEqual(p.people.map(m => m.name));
        expect(p.people.filter(m => m.status === 'ai_active')).toHaveLength(107);
    });

    it('a reveal answers names and says the audit row was recorded; pages follow the cursor', () => {
        const p = call<People>('GET /api/usage/adoption/people', 'days=30&reveal=true&limit=50');
        expect(p.reveal).toBe(true);
        expect(p.auditRecorded).toBe(true);
        expect(p.people[0].name).not.toMatch(/^Member · /);
        expect(p.nextCursor).toBe(50);
        const next = call<People>('GET /api/usage/adoption/people', 'days=30&limit=50&cursor=100');
        expect(next.people).toHaveLength(48);
        expect(next.nextCursor).toBeNull();
    });

    it('the people\'s costs add up to the spend', () => {
        const s = call<Summary>('GET /api/usage/adoption/summary', 'days=30');
        const p = call<People>('GET /api/usage/adoption/people', 'days=30&limit=200');
        expect(Math.abs(p.people.reduce((x, m) => x + m.cost, 0) - s.spend.cost)).toBeLessThan(1);
    });

    it('a kind\'s drill-down keeps its top users pseudonymous', () => {
        const d = call<{ topPeople: Array<{ person: string }>; items: unknown[]; total: number }>('GET /api/usage/adoption/studio/items', 'kind=agent');
        expect(d.total).toBe(42);
        expect(d.items.length).toBeGreaterThan(0);
        for (const tp of d.topPeople) expect(tp.person).toMatch(/^Member · /);
    });
});
