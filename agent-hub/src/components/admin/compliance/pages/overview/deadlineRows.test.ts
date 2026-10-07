import { describe, expect, it } from 'vitest';
import { MAX_SOON, deadlineRef, deadlineSubjectKind, emptyLines, splitDeadlines, targetOf } from './deadlineRows';

/**
 * The rules a deadline row follows on the Overview and on the phone: what is
 * pressing, which identifier a row prints, which empty registers share one
 * line, and where a row goes. The rendering is pinned in DeadlinesCard.test.tsx.
 */
const NOW = new Date('2026-10-07T12:00:00Z').getTime();
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

describe('splitDeadlines', () => {
    it('a done clock is never pressing; an urgent one always is', () => {
        const { soon, later } = splitDeadlines([
            { id: 'a', state: 'done', due_at: at(1) },
            { id: 'b', state: 'urgent', due_at: at(400) },
            { id: 'c', state: 'ok', due_at: at(31) },
            { id: 'd', state: 'ok', due_at: at(29) },
        ], NOW);
        expect(soon.map((i) => i.id)).toEqual(['b', 'd']);
        expect(later.map((i) => i.id)).toEqual(['a', 'c']);
    });

    it('keeps at most MAX_SOON pressing clocks on the first screen, in order', () => {
        const items = Array.from({ length: MAX_SOON + 2 }, (_, i) => ({ id: `o${i}`, state: 'overdue', due_at: at(-i) }));
        const { soon, later } = splitDeadlines(items, NOW);
        expect(soon).toHaveLength(MAX_SOON);
        expect(later.map((i) => i.id)).toEqual([`o${MAX_SOON}`, `o${MAX_SOON + 1}`]);
    });

    it('no list is no clocks, never a crash', () => {
        expect(splitDeadlines(null, NOW)).toEqual({ soon: [], later: [] });
    });
});

describe('deadlineRef and deadlineSubjectKind', () => {
    it('split the same field by kind', () => {
        expect(deadlineRef({ kind: 'dsr', ref: '#9' })).toBe('#9');
        expect(deadlineRef({ kind: 'cra_full_report', ref: 'INC-4' })).toBe('INC-4');
        expect(deadlineRef({ kind: 'obligation', ref: 'training' })).toBeNull();
        expect(deadlineSubjectKind({ kind: 'obligation', ref: 'management review' })).toBe('Management review');
        expect(deadlineSubjectKind({ kind: 'attestation_expiry', ref: 'Agent' })).toBe('Agent');
        expect(deadlineSubjectKind({ kind: 'dsr', ref: '#9' })).toBeNull();
        expect(deadlineSubjectKind({ kind: 'obligation', ref: '  ' })).toBeNull();
    });
});

describe('emptyLines', () => {
    it('dedupes by sentence, never two unknown kinds into one', () => {
        expect(emptyLines(['cra_early_warning', 'cra_full_report']).map((l) => l.id)).toEqual(['compliance.ovw_no_open_cra']);
        expect(emptyLines(['obligation', 'attestation_expiry'])).toHaveLength(2);
        expect(emptyLines(['dsr', 'cra_vulnerability', 'dsr']).map((l) => l.kind)).toEqual(['dsr', 'cra_vulnerability']);
    });
});

describe('targetOf', () => {
    it('reads an app path (server) and a { section, id } object (client fallback)', () => {
        expect(targetOf({ target: '/app/admin/compliance/dsr/dsr_2417' })).toEqual({ section: 'dsr', id: 'dsr_2417', tab: undefined });
        expect(targetOf({ target: { section: 'incidents', id: '31' } })).toEqual({ section: 'incidents', id: '31', tab: undefined });
        expect(targetOf({ target: '/app/admin/compliance/overview?tab=calendar' })).toEqual({ section: 'overview', id: undefined, tab: 'calendar' });
    });

    it('null when the row has no target or it leaves the hub', () => {
        expect(targetOf({ target: null })).toBeNull();
        expect(targetOf({ target: { id: '3' } })).toBeNull();
        expect(targetOf({ target: 'https://example.org/elsewhere' })).toBeNull();
    });
});
