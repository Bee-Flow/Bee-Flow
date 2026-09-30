/**
 * Folding "Needs attention": one line per source and code, the worst severity
 * of the group, the first row's order kept, and words that say what the
 * group is.
 */

import type { AttentionRow } from './api';
import { groupAttention, groupWords, sourceWords } from './attentionGroups';

function row(over: Partial<AttentionRow>): AttentionRow {
    return {
        source: 'appValidation',
        code: 'binding.table_unverified',
        severity: 'warning',
        kind: 'app',
        targetId: 'a1',
        message: 'records binding references "tbl_1" — not verified until publish.',
        remediation: 'Publishing checks it exists.',
        deepLink: '/app/studio/apps/a1',
        ...over,
    };
}

describe('groupAttention', () => {
    it('folds findings with the same source and code, in first-row order', () => {
        const groups = groupAttention([
            row({ source: 'automationFailing', code: 'automation.consecutive_failures', severity: 'error', message: 'Invoices failed' }),
            row({ targetId: 'a1' }),
            row({ targetId: 'a2' }),
            row({ code: 'binding.table_unset', remediation: 'Connect it before publishing.' }),
            row({ targetId: 'a3' }),
        ]);
        expect(groups.map((g) => [g.key, g.rows.length])).toEqual([
            ['automationFailing:automation.consecutive_failures', 1],
            ['appValidation:binding.table_unverified', 3],
            ['appValidation:binding.table_unset', 1],
        ]);
    });

    it('takes the worst severity in the group', () => {
        const [group] = groupAttention([row({ severity: 'info' }), row({ severity: 'error' }), row({ severity: 'warning' })]);
        expect(group?.severity).toBe('error');
    });

    it('draws nothing for nothing', () => {
        expect(groupAttention([])).toEqual([]);
    });
});

describe('groupWords', () => {
    it("lets one finding speak in the producer's own sentence", () => {
        const [group] = groupAttention([row({ message: 'Invoices failed three times' })]);
        expect(groupWords(group!)).toEqual({ title: { text: 'Invoices failed three times' }, detail: 'Publishing checks it exists.' });
    });

    it('names several by their source, with the remediation they share', () => {
        const [group] = groupAttention([row({}), row({ targetId: 'a2' })]);
        expect(groupWords(group!)).toEqual({
            title: { key: 'studio.attention.src_app_validation', fallback: 'App has validation problems' },
            detail: 'Publishing checks it exists.',
        });
    });

    it('leaves the detail out when the group does not share one', () => {
        const [group] = groupAttention([row({}), row({ remediation: 'Something else.' })]);
        expect(groupWords(group!).detail).toBeNull();
    });

    it('falls back to the source line, then the code, when there is no sentence', () => {
        const [one] = groupAttention([row({ message: '' })]);
        expect(groupWords(one!).title).toEqual({ key: 'studio.attention.src_app_validation', fallback: 'App has validation problems' });
        const [unknown] = groupAttention([row({ source: 'later', code: 'x.y' }), row({ source: 'later', code: 'x.y' })]);
        expect(groupWords(unknown!).title).toEqual({ text: 'x.y' });
    });
});

describe('sourceWords', () => {
    it("names a group by its source's line, or its code when the source is new", () => {
        expect(sourceWords({ source: 'agentNoKb', code: 'agent.no_knowledge_base' })).toEqual({
            key: 'studio.attention.src_agent_no_kb',
            fallback: 'Agent has no knowledge base',
        });
        expect(sourceWords({ source: 'later', code: 'x.y' })).toEqual({ text: 'x.y' });
    });
});
