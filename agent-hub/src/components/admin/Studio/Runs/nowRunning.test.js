// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NOW_RUNNING_LIMIT, nowRunningLines, readRollups, toLine } from './nowRunning';

const roll = (over = {}) => ({
    automationId: 'a1', title: 'Weekly digest', kind: 'automation',
    total: 3, status: { success: 3 }, lastRunAt: '2026-09-07T10:00:00.000Z',
    lastErrorAt: null, lastErrorClass: null,
    ...over,
});

describe('readRollups — an unreadable rollup is not an empty one', () => {
    it('reads the array when it is there', () => {
        expect(readRollups({ automations: [roll()] })).toHaveLength(1);
        expect(readRollups({ automations: [] })).toEqual([]);
    });

    it('answers null — not [] — for everything it cannot read', () => {
        // Each of these would otherwise render as "nothing ran in the last 24
        // hours", which is a claim about the organisation that nobody checked:
        // a facets read that 403'd, one that never returned, and a server
        // without the rollup all look identical to `facets?.automations || []`.
        for (const bad of [undefined, null, {}, [], 'facets', 0, { automations: null },
            { automations: 'many' }, { automations: { a1: 3 } }, { status: {} }]) {
            expect(nowRunningLines(bad), JSON.stringify(bad)).toBeNull();
            expect(readRollups(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it('drops junk entries but keeps the list readable', () => {
        expect(readRollups({ automations: [roll(), null, {}, { title: 'no id' }, 7] })).toHaveLength(1);
    });
});

describe('toLine — the most urgent thing in the window wins', () => {
    it('an automation that failed reads as failed even if it succeeded since', () => {
        // Burying this morning's two failures under "done · 38 runs" is how a
        // strip like this stops being read at all.
        const line = toLine(roll({ total: 38, status: { success: 36, error: 2 }, lastErrorAt: '2026-09-07T08:00:00.000Z', lastErrorClass: 'timeout' }));
        expect(line.tone).toBe('error');
        expect(line.errors).toBe(2);
        expect(line.total).toBe(38);
        expect(line.errorClass).toBe('timeout');
        // The line points at the moment it BROKE, not the last success.
        expect(line.at).toBe('2026-09-07T08:00:00.000Z');
    });

    it('waiting beats running, running beats done', () => {
        expect(toLine(roll({ status: { awaiting_approval: 1, running: 2, success: 5 } })).tone).toBe('waiting');
        expect(toLine(roll({ status: { awaiting_form: 1 } })).tone).toBe('waiting');
        expect(toLine(roll({ status: { awaiting_confirm: 1 } })).tone).toBe('waiting');
        expect(toLine(roll({ status: { running: 1, success: 5 } })).tone).toBe('running');
        expect(toLine(roll({ status: { queued: 1 } })).tone).toBe('running');
        expect(toLine(roll({ status: { success: 5 } })).tone).toBe('done');
        expect(toLine(roll({ status: { cancelled: 2 } })).tone).toBe('done');
    });

    it('never carries a free-text error message, only its class', () => {
        // The message can quote a customer, and in the org scope it is
        // somebody else's customer. Whatever the server sends, the line
        // exposes exactly one error field and it is the class.
        const line = toLine(roll({
            status: { error: 1 },
            lastErrorClass: 'auth',
            error: 'Could not e-mail jan@example.com',
            lastError: 'Could not e-mail jan@example.com',
        }));
        expect(line.errorClass).toBe('auth');
        expect(JSON.stringify(line)).not.toContain('jan@example.com');
    });

    it('a missing title stays null rather than becoming a name', () => {
        expect(toLine(roll({ title: null })).title).toBeNull();
        expect(toLine(roll({ title: '   ' })).title).toBeNull();
        expect(toLine(roll({ title: 42 })).title).toBeNull();
    });

    it('tolerates a status map full of junk without inventing counts', () => {
        const line = toLine(roll({ total: 'lots', status: { error: 'two', success: null } }));
        expect(line.total).toBe(0);
        expect(line.errors).toBe(0);
        expect(line.tone).toBe('done');
    });
});

describe('nowRunningLines — order, cap and the honest total', () => {
    const facets = (automations, extra = {}) => ({ automations, ...extra });

    it('sorts by urgency first, then by recency inside a bucket', () => {
        const out = nowRunningLines(facets([
            roll({ automationId: 'done-old', status: { success: 1 }, lastRunAt: '2026-09-07T01:00:00.000Z' }),
            roll({ automationId: 'run', status: { running: 1 }, lastRunAt: '2026-09-07T02:00:00.000Z' }),
            roll({ automationId: 'err-old', status: { error: 1 }, lastErrorAt: '2026-09-07T03:00:00.000Z' }),
            roll({ automationId: 'wait', status: { awaiting_approval: 1 }, lastRunAt: '2026-09-07T04:00:00.000Z' }),
            roll({ automationId: 'err-new', status: { error: 1 }, lastErrorAt: '2026-09-07T09:00:00.000Z' }),
            roll({ automationId: 'done-new', status: { success: 1 }, lastRunAt: '2026-09-07T05:00:00.000Z' }),
        ]));
        expect(out.lines.map(l => l.automationId)).toEqual(['err-new', 'err-old', 'wait', 'run', 'done-new', 'done-old']);
    });

    it('caps the lines and says how many are not shown', () => {
        const many = Array.from({ length: 9 }, (_, i) => roll({ automationId: `a${i}` }));
        const out = nowRunningLines(facets(many), { limit: 3 });
        expect(out.lines).toHaveLength(3);
        expect(out.total).toBe(9);
        expect(out.hidden).toBe(6);
    });

    it('counts the automations the server capped away, not just the ones it did not draw', () => {
        // The server caps its rollup too. "and 34 more" must mean the
        // organisation's 40 automations, not the 40 minus what arrived.
        const arrived = Array.from({ length: 6 }, (_, i) => roll({ automationId: `a${i}` }));
        const out = nowRunningLines(facets(arrived, { automationsTotal: 40 }), { limit: 6 });
        expect(out.lines).toHaveLength(6);
        expect(out.total).toBe(40);
        expect(out.hidden).toBe(34);
    });

    it('ignores a server total that is smaller than what actually arrived', () => {
        const arrived = [roll({ automationId: 'a1' }), roll({ automationId: 'a2' })];
        const out = nowRunningLines(facets(arrived, { automationsTotal: 1 }));
        expect(out.total).toBe(2);
        expect(out.hidden).toBe(0);
    });

    it('an empty window is an empty list, and that is a real answer', () => {
        expect(nowRunningLines(facets([]))).toEqual({ lines: [], total: 0, hidden: 0 });
    });

    it('defaults to the documented line limit', () => {
        const many = Array.from({ length: NOW_RUNNING_LIMIT + 4 }, (_, i) => roll({ automationId: `a${i}` }));
        expect(nowRunningLines(facets(many)).lines).toHaveLength(NOW_RUNNING_LIMIT);
    });
});
