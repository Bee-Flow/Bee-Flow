// @vitest-environment node
//
// Two node cards name something that lives OUTSIDE the definition — a
// datatable and a knowledge base — and can only do it from the builder's
// catalog. That is threaded here, once per layout.
//
// The trap this file exists for is not that the names are wrong, but that they
// are ABSENT and the card says something confident anyway. `DatatableNode` read
// `data.tableNameById` and `data.datatablesById` from the day it shipped;
// nothing ever put them there, so every datatable card summarised itself as
// "look up rows in a table you can no longer see" — about a table sitting right
// there in the picker. Silent, and it looks like data loss.
//
// So: prove the maps ARRIVE, and prove that when they genuinely cannot (no
// catalog yet) the summary says something true rather than something alarming.

import { describe, it, expect } from 'vitest';
import { buildLayout } from './layout';
import { datatableSummary, knowledgeWriteSummary } from './nodeSummaries';

const CATALOG = {
    datatables: [{ id: 'tbl_1', name: 'Customers', scope: 'org' }],
    knowledgeBases: [{ id: 'kb_1', name: 'Handbook', canWrite: true, scope: 'org' }],
};

const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'dt', type: 'datatable', op: 'find_rows', datatableId: 'tbl_1' },
        { id: 'kw', type: 'knowledge_write', knowledgeBaseId: 'kb_1', content: '{{trigger.output.x}}' },
    ],
    edges: [{ from: 'trg', to: 'dt' }, { from: 'dt', to: 'kw' }],
};

const dataFor = (nodes, id) => nodes.find(n => n.id === id)?.data;

describe('buildLayout threads the catalog name maps onto every card', () => {
    it('a datatable card can name its table', () => {
        const { nodes } = buildLayout(DEF, { runByStep: new Map(), issuesByStep: new Map(), catalog: CATALOG });
        const data = dataFor(nodes, 'dt');
        expect(data.tableNameById).toEqual({ tbl_1: 'Customers' });
        expect(data.datatablesById.tbl_1.scope).toBe('org');
        expect(datatableSummary(data.step, data)).toBe('Find rows in Customers');
    });

    it('a knowledge-write card can name its base', () => {
        const { nodes } = buildLayout(DEF, { runByStep: new Map(), issuesByStep: new Map(), catalog: CATALOG });
        const data = dataFor(nodes, 'kw');
        expect(data.kbNameById).toEqual({ kb_1: 'Handbook' });
        expect(knowledgeWriteSummary(data.step, data)).toBe('Save into Handbook');
    });

    it('with no catalog yet, neither card claims the thing is gone', () => {
        // The first paint happens before the catalog request resolves. A card
        // that reads "you can no longer see this" in that window is telling the
        // author their table was deleted.
        //
        // The summaries are called with the node's OWN data — the first version
        // of this test passed a hand-made {} instead, which exercised a path the
        // real code never takes: buildLayout used to hand the card empty maps,
        // `{}` is truthy, and the fallback under test could never fire. The test
        // was green and proved nothing.
        const { nodes } = buildLayout(DEF, { runByStep: new Map(), issuesByStep: new Map() });
        const dt = dataFor(nodes, 'dt');
        const kw = dataFor(nodes, 'kw');
        expect(dt.tableNameById).toBeUndefined();
        expect(datatableSummary(dt.step, dt)).toEqual({ muted: 'find rows in a table' });
        expect(knowledgeWriteSummary(kw.step, kw)).toBe('Save into a knowledge base');
    });

    it('a table that really IS gone still says so, once the catalog has loaded', () => {
        const gone = { ...DEF.steps[0], datatableId: 'tbl_deleted' };
        expect(datatableSummary(gone, { tableNameById: { tbl_1: 'Customers' } }))
            .toEqual({ muted: 'find rows in a table you can no longer see' });
    });

    it('an EMPTY catalog is not the same as NO catalog', () => {
        // A catalog that loaded and holds nothing is a real answer: the table is
        // genuinely gone. A catalog that has not loaded is not an answer at all.
        // The two must not collapse, which is exactly what handing every card
        // `{}` did.
        const { nodes } = buildLayout(DEF, { runByStep: new Map(), issuesByStep: new Map(), catalog: { datatables: [], knowledgeBases: [] } });
        const dt = dataFor(nodes, 'dt');
        expect(dt.tableNameById).toEqual({});
        expect(datatableSummary(dt.step, dt)).toEqual({ muted: 'find rows in a table you can no longer see' });
    });
});
