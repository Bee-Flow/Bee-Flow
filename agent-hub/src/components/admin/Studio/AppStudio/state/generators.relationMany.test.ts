import { describe, expect, it } from 'vitest';
import { buildFormForTable } from './generators';

// A many relation (relation.many) is written as a list of record ids, so the generated form's
// relation picker takes several rows; a one-row relation keeps the single picker it had.
const TABLE = {
    id: 'tbl_proj01', key: 'projects', name: 'Projects',
    fields: [
        { id: 'fld_r01', key: 'owner', name: 'Owner', type: 'relation', relation: { table: 'tbl_ppl01' } },
        { id: 'fld_r02', key: 'tags', name: 'Tags', type: 'relation', relation: { table: 'tbl_tag01', many: true } },
    ],
};

describe('buildFormForTable with a many relation', () => {
    it('makes the picker of a many relation take several rows, and leaves a one-row relation single', () => {
        const { node, actions } = buildFormForTable(TABLE as never);
        const byName = Object.fromEntries((node.children ?? []).map((c) => [c.props?.name, c]));
        expect(byName.tags.type).toBe('input_relation');
        expect(byName.tags.props).toMatchObject({ tableId: 'tbl_tag01', multiple: true });
        expect(byName.owner.props.multiple).toBe(false);
        // The create_record step still reads the field by its input name: the list goes as it is.
        const [action] = Object.values(actions ?? {}) as Array<{ steps?: Array<{ values?: Record<string, unknown> }> }>;
        expect(JSON.stringify(action)).toContain('"tags":{"kind":"field","name":"tags"}');
    });
});
