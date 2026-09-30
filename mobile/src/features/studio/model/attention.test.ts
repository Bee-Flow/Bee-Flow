/** The one line under "Needs attention": only `complete` licenses "nothing needs attention". */

import { attentionLine, attentionSections, rowKind, worstSeverity } from './attention';

const base = { total: 0, complete: true, unavailable: [] as string[], capped: [] as string[] };

describe('attentionLine', () => {
    it('says "nothing" only over a complete answer', () => {
        expect(attentionLine(base)).toBe('empty');
        expect(attentionLine({ ...base, complete: false, unavailable: ['agentNoKb'] })).toBe('empty_unchecked');
    });

    it('tells a size apart from a breakdown', () => {
        expect(attentionLine({ ...base, complete: false, capped: ['solutionBlocked'] })).toBe('empty_capped');
        expect(attentionLine({ ...base, total: 2, complete: false, capped: ['solutionBlocked'] })).toBe('partial_capped');
        expect(attentionLine({ ...base, total: 2, complete: false, unavailable: ['x'], capped: ['y'] })).toBe('partial');
    });

    it('says nothing over rows from a complete answer — the rows speak', () => {
        expect(attentionLine({ ...base, total: 2 })).toBeNull();
    });
});

describe('attentionSections', () => {
    it('names each source by its section, once, bare or prefixed', () => {
        expect(attentionSections(['kbEmptyInUse', 'studio:kbSourceError', 'agentNoKb', 'mystery'])).toEqual([
            'knowledge',
            'agents',
        ]);
    });
});

describe('worstSeverity / rowKind', () => {
    it('picks the worst severity for the heading', () => {
        expect(worstSeverity([{ severity: 'info' }, { severity: 'error' }] as never)).toBe('error');
        expect(worstSeverity([])).toBe('info');
    });

    it('draws a tile only for a known kind', () => {
        expect(rowKind('kb')).toBe('kb');
        expect(rowKind('mystery')).toBeNull();
    });
});
