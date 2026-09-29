// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    themeOf, decisionOf, countByDecision, countByTheme, indexChecks, liveCheckOf,
    approvedBlocked, justificationMissing, filterControls, pageSlice, draftOf, patchOf, PAGE_LIMIT,
} from './soaThemes';

/** 93 Annex A refs with the real theme sizes: A.5 ×37, A.6 ×8, A.7 ×14, A.8 ×34. */
function annexA() {
    const sizes = { 5: 37, 6: 8, 7: 14, 8: 34 };
    const out = [];
    for (const [theme, n] of Object.entries(sizes)) {
        for (let i = 1; i <= n; i++) out.push({ ref: `A.${theme}.${i}`, theme: Number(theme), titleKey: `k.${theme}.${i}`, checks: [], entry: null });
    }
    return out;
}

describe('soaThemes — themes', () => {
    it('resolves the theme from the ref prefix, then from the numeric theme, else null', () => {
        expect(themeOf('A.5.20')).toBe('A.5');
        expect(themeOf({ ref: 'A.8.12' })).toBe('A.8');
        expect(themeOf({ ref: 'X.1', theme: 7 })).toBe('A.7');
        expect(themeOf({ ref: 'A.9.1' })).toBe(null);
        expect(themeOf(null)).toBe(null);
    });

    it('counts 93 controls into 37 · 8 · 14 · 34 with badge totals', () => {
        const counts = countByTheme(annexA());
        expect(counts).toEqual({ all: 93, 'A.5': 37, 'A.6': 8, 'A.7': 14, 'A.8': 34 });
    });
});

describe('soaThemes — decisions', () => {
    it('excluded wins over the stored status; a missing entry is todo', () => {
        expect(decisionOf({ entry: null })).toBe('todo');
        expect(decisionOf({ entry: { status: 'approved', applicable: true } })).toBe('approved');
        expect(decisionOf({ entry: { status: 'approved', applicable: false } })).toBe('excluded');
        expect(decisionOf({ entry: { status: 'weird', applicable: true } })).toBe('todo');
    });

    it('counts by decision like the artboard pills (9 approved · 61 to review · 20 reviewed · 3 excluded)', () => {
        const rows = annexA();
        rows.slice(0, 9).forEach(c => { c.entry = { status: 'approved', applicable: true }; });
        rows.slice(9, 29).forEach(c => { c.entry = { status: 'reviewed', applicable: true }; });
        rows.slice(29, 32).forEach(c => { c.entry = { status: 'reviewed', applicable: false }; });
        expect(countByDecision(rows)).toEqual({ all: 93, approved: 9, reviewed: 20, excluded: 3, todo: 61 });
    });
});

describe('soaThemes — live checks', () => {
    const checks = [
        { check_id: 'ISO-A5-20', status: 'pass', regulation: 'ISO27001' },
        { check_id: 'ISO-A5-20', status: 'warn', regulation: 'ISO27001' }, // another subject — worst wins
        { check_id: 'GDPR-28', status: 'pass', regulation: 'GDPR' },
    ];
    const byId = indexChecks(checks);

    it('indexes the worst row per check id', () => {
        expect(byId.get('ISO-A5-20').status).toBe('warn');
        expect(byId.get('GDPR-28').status).toBe('pass');
    });

    it('resolves none / pending / result', () => {
        expect(liveCheckOf({ checks: [], entry: null }, byId)).toEqual({ kind: 'none' });
        expect(liveCheckOf({ checks: ['NOPE'], entry: null }, byId)).toEqual({ kind: 'pending', ids: ['NOPE'] });
        const live = liveCheckOf({ checks: ['GDPR-28', 'ISO-A5-20'], entry: null }, byId);
        expect(live.kind).toBe('result');
        expect(live.status).toBe('warn');
        expect(live.others.map(o => o.check_id)).toEqual(['GDPR-28']);
    });

    it('an excluded control has no live check even when one is linked', () => {
        expect(liveCheckOf({ checks: ['ISO-A5-20'], entry: { applicable: false, status: 'todo' } }, byId)).toEqual({ kind: 'none' });
    });

    it('approved is blocked only while the linked check is warn or fail', () => {
        expect(approvedBlocked({ kind: 'result', status: 'warn' })).toBe(true);
        expect(approvedBlocked({ kind: 'result', status: 'fail' })).toBe(true);
        expect(approvedBlocked({ kind: 'result', status: 'pass' })).toBe(false);
        expect(approvedBlocked({ kind: 'pending', ids: ['x'] })).toBe(false);
        expect(approvedBlocked({ kind: 'none' })).toBe(false);
    });
});

describe('soaThemes — justification rule and patch', () => {
    it('excluded without a justification cannot be saved; whitespace does not count', () => {
        expect(justificationMissing({ status: 'excluded', justification: '' })).toBe(true);
        expect(justificationMissing({ status: 'excluded', justification: '   ' })).toBe(true);
        expect(justificationMissing({ status: 'excluded', justification: 'Fully cloud, no server room.' })).toBe(false);
        expect(justificationMissing({ status: 'todo', justification: '' })).toBe(false);
    });

    it('draft → patch is an allow-list: excluded becomes applicable:false with the stored status kept', () => {
        const control = { ref: 'A.7.4', entry: { status: 'reviewed', applicable: false, justification: 'cloud', how_met: null, owner_user_id: 'u1', updated_at: 'x', extra: 'leak' } };
        const draft = draftOf(control);
        expect(draft).toEqual({ status: 'excluded', storedStatus: 'reviewed', how_met: '', justification: 'cloud', owner_user_id: 'u1' });
        expect(patchOf(draft)).toEqual({ status: 'reviewed', applicable: false, justification: 'cloud', how_met: null, owner_user_id: 'u1' });
        expect(patchOf({ ...draft, status: 'approved', owner_user_id: '' })).toEqual({ status: 'approved', applicable: true, justification: 'cloud', how_met: null, owner_user_id: null });
    });
});

describe('soaThemes — filter and pager', () => {
    it('filters by decision, theme and text (ref, translated title, how met)', () => {
        const rows = annexA();
        rows[0].entry = { status: 'approved', applicable: true, how_met: 'Policy v3 published' };
        const t = (key) => (key === 'k.5.1' ? 'Information security policies' : key);
        expect(filterControls(rows, { decision: 'approved' }).map(c => c.ref)).toEqual(['A.5.1']);
        expect(filterControls(rows, { theme: 'A.6' })).toHaveLength(8);
        expect(filterControls(rows, { query: 'a.8.12' }).map(c => c.ref)).toEqual(['A.8.12']);
        expect(filterControls(rows, { query: 'security polic', t }).map(c => c.ref)).toEqual(['A.5.1']);
        expect(filterControls(rows, { query: 'v3 publ' }).map(c => c.ref)).toEqual(['A.5.1']);
        expect(filterControls(null, {})).toEqual([]);
    });

    it('pages 12 at a time over 93 rows and clamps an offset past the end onto the last page', () => {
        const rows = annexA();
        expect(PAGE_LIMIT).toBe(12);
        const first = pageSlice(rows, 0);
        expect(first.rows).toHaveLength(12);
        expect(first.total).toBe(93);
        expect(first.rows[0].ref).toBe('A.5.1');
        const last = pageSlice(rows, 84);
        expect(last.rows).toHaveLength(9);
        expect(last.rows[8].ref).toBe('A.8.34');
        expect(pageSlice(rows, 999).offset).toBe(84);
        expect(pageSlice([], 24)).toEqual({ rows: [], offset: 0, limit: 12, total: 0 });
    });
});
