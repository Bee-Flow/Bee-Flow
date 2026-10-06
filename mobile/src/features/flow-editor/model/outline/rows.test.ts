import type { FlowDefinition } from '@/features/flow-editor/model';
import { branchy, chain, FIXTURES, loopy, multi, switchy } from '@/features/flow-editor/model/testing/fixtures';

import { buildOutlineRows, groupKey } from './rows';
import type { OutlineRow, RowText } from './types';

const tangled = FIXTURES.tangled as FlowDefinition;

const words = (t: RowText) => ('raw' in t ? t.raw : t.fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(t.params?.[k] ?? '')));

/** One line per row, indented by depth — the outline as a person reads it. */
function lines(rows: OutlineRow[]): string[] {
    return rows.map((r) => {
        const pad = 'depth' in r ? '  '.repeat(r.depth) : '';
        switch (r.kind) {
            case 'trigger':
                return `${pad}T ${r.nodeId}${r.primary ? '' : ' (secondary)'}`;
            case 'step':
                return `${pad}S ${r.address}`;
            case 'lane':
                return `${pad}L ${words(r.text)}`;
            case 'group':
                return `${pad}G ${words(r.text)} (${r.count})${r.collapsed ? ' folded' : ''}`;
            case 'jump':
                return `${pad}J ${r.back ? 'back to' : 'on at'} ${r.toId}`;
            case 'section':
                return `# ${words(r.text)}`;
            default: {
                const t = r.target;
                const where =
                    t.kind === 'after' ? `after ${t.sourceId}${t.handle ? `:${t.handle}` : ''}`
                    : t.kind === 'splice' ? `on ${t.sourceId}>${t.targetId}${t.identity.label ? `:${t.identity.label}` : ''}`
                    : t.kind === 'inline' ? `in ${t.container}${t.branch === null ? '' : `#${t.branch}`}@${t.index}`
                    : 'root';
                return `${pad}+ ${where}${r.end ? ' (end)' : ''}`;
            }
        }
    });
}

describe('buildOutlineRows', () => {
    it('lists a straight chain with a "+" between every two cards', () => {
        const out = lines(buildOutlineRows(chain));
        expect(out.slice(0, 5)).toEqual(['T trg', '+ on trg>c0', 'S c0', '+ on c0>c1', 'S c1']);
        expect(out.slice(-2)).toEqual(['S c11', '+ after c11 (end)']);
    });

    it('opens a lane per condition port and closes them where they meet', () => {
        expect(lines(buildOutlineRows(branchy))).toEqual([
            'T trg',
            '+ on trg>cond_1',
            'S cond_1',
            '  L Match',
            '  + on cond_1>act_a:then',
            '  S act_a',
            '  + on act_a>notif_1 (end)',
            '  L Otherwise',
            '  + on cond_1>act_b:else',
            '  S act_b',
            '  + on act_b>notif_1 (end)',
            'S notif_1',
            '+ after notif_1 (end)',
        ]);
    });

    it('names switch lanes by case, keeps legacy case spellings, and adds the error path', () => {
        const out = lines(buildOutlineRows(switchy));
        expect(out.filter((l) => l.trim().startsWith('L'))).toEqual(['  L gold', '  L silver', '  L bronze', '  L Otherwise', '  L On error']);
        // The error path goes to the join itself: a "+" on that edge, nothing drawn twice.
        expect(out).toContain('  + on sw>end:on_error (end)');
        expect(out.filter((l) => l.trim() === 'S end')).toHaveLength(1);
        // Stop with an error ends its lane: no "+" after it.
        expect(out).not.toContain('  + after dflt (end)');
    });

    it('draws a loop body as a group of held steps with a "+" around each', () => {
        const out = lines(buildOutlineRows(loopy));
        expect(out.slice(0, 6)).toEqual(['T trg', '+ on trg>loop_1', 'S loop_1', '  G For each item (3)', '  + in loop_1@0', '  S loop_1/b_cond']);
        expect(out).toContain('  + in loop_1@3 (end)');
        expect(out).toContain('S lim');
    });

    it('folds a group the reader collapsed', () => {
        const out = lines(buildOutlineRows(loopy, { collapsed: new Set([groupKey('loop_1', null)]) }));
        expect(out).toContain('  G For each item (3) folded');
        expect(out.some((l) => l.includes('loop_1/'))).toBe(false);
    });

    it('lists secondary triggers under the primary, and a flow only they start in its own section', () => {
        const out = lines(buildOutlineRows(multi));
        expect(out.slice(0, 3)).toEqual(['T trg', 'T trg_hook (secondary)', 'T trg_evt (secondary)']);
        expect(out).toContain('# Also starts from App event');
        const section = out.indexOf('# Also starts from App event');
        expect(out.slice(section, section + 3)).toEqual(['# Also starts from App event', '+ on trg_evt>ai_2', 'S ai_2']);
        // Notes are canvas annotations, not steps.
        expect(out.some((l) => l.includes('note_1'))).toBe(false);
    });

    it('shows a way back as a jump, never a step twice, and lists what nothing reaches', () => {
        const out = lines(buildOutlineRows(tangled));
        expect(out).toContain('J back to y');
        expect(out.filter((l) => l === 'S y')).toHaveLength(1);
        expect(out.slice(-3)).toEqual(['# Not connected', 'S loose', '+ after loose (end)']);
    });

    it('offers only a trigger slot on a graph without one', () => {
        const def: FlowDefinition = { steps: [], edges: [] };
        expect(lines(buildOutlineRows(def))).toEqual(['+ root (end)']);
    });

    it('gives every row a unique key', () => {
        for (const def of [chain, branchy, switchy, loopy, multi, tangled]) {
            const keys = buildOutlineRows(def).map((r) => r.key);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it('draws each parallel branch as its own group', () => {
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'par', type: 'parallel', branches: [[{ id: 'a1', type: 'set' }], []] }],
            edges: [{ from: 'trg', to: 'par' }],
        };
        expect(lines(buildOutlineRows(def))).toEqual([
            'T trg',
            '+ on trg>par',
            'S par',
            '  G Branch 1 (1)',
            '  + in par#0@0',
            '  S par/a1',
            '  + in par#0@1 (end)',
            '  G Branch 2 (0)',
            '  + in par#1@0 (end)',
            '+ after par (end)',
        ]);
    });

    it('shows two plain edges out of one step as side-by-side paths', () => {
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'a', type: 'set' }, { id: 'b', type: 'set' }, { id: 'c', type: 'set' }],
            edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'c' }],
        };
        const out = lines(buildOutlineRows(def));
        expect(out.filter((l) => l.trim().startsWith('L'))).toEqual(['  L Path 1', '  L Path 2']);
    });
});
