import {
    draftFrom,
    draftReady,
    emptyDraft,
    scopesFor,
    seedDraft,
    sortTemplates,
    templateRows,
} from './draft';
import { scopeLabel, templateScopeText } from './labels';

const t = (_key: string, fallback: string) => fallback;

describe('the template draft', () => {
    it('needs a name, a prompt and, for a group, the group', () => {
        expect(draftReady(emptyDraft())).toBe(false);
        const ready = { ...emptyDraft(), name: 'A', prompt: 'B' };
        expect(draftReady(ready)).toBe(true);
        expect(draftReady({ ...ready, scope: 'group' })).toBe(false);
        expect(draftReady({ ...ready, scope: 'group', groupId: 'g' })).toBe(true);
        expect(draftReady({ ...ready, name: '  ' })).toBe(false);
    });

    it('copies a stored template', () => {
        expect(draftFrom({ id: 't', name: 'N', scope: 'group', groupId: 'g', isDefault: true })).toEqual({
            name: 'N',
            prompt: '',
            scope: 'group',
            groupId: 'g',
            isDefault: true,
        });
    });

    it('offers org and group scopes to an org admin only', () => {
        expect(scopesFor(false)).toEqual(['user']);
        expect(scopesFor(true)).toEqual(['user', 'org', 'group']);
    });

    it('seeds the prompt, and the name only while it is blank', () => {
        const builtin = { id: 'g', name: 'General', prompt: 'Write…' };
        expect(seedDraft(emptyDraft(), builtin)).toMatchObject({ name: 'General', prompt: 'Write…' });
        expect(seedDraft({ ...emptyDraft(), name: 'Mine' }, builtin).name).toBe('Mine');
    });

    it('lists the default first, then by name', () => {
        const sorted = sortTemplates([
            { id: '1', name: 'b' },
            { id: '2', name: 'a' },
            { id: '3', name: 'z', isDefault: true },
        ]);
        expect(sorted.map((x) => x.id)).toEqual(['3', '2', '1']);
    });
});

describe('scope words', () => {
    it('uses the web wording and the group name when known', () => {
        expect(scopeLabel('user', t)).toBe('Just me');
        expect(scopeLabel('org', t)).toBe('Whole organization');
        const groupTpl = { id: 't', name: 'x', scope: 'group' as const, groupId: 'g1' };
        expect(templateScopeText(groupTpl, [{ id: 'g1', name: 'Sales' }], t)).toBe('Sales');
        expect(templateScopeText(groupTpl, [], t)).toBe('Specific group');
    });
});

describe('templateRows', () => {
    const mine = { id: 'u1', name: 'Mine', scope: 'user' as const };
    const orgTpl = { id: 'o1', name: 'Org', scope: 'org' as const };
    const groupTpl = { id: 'g1', name: 'Group', scope: 'group' as const, groupId: 'g' };

    it('lets anyone but an admin write only their personal templates', () => {
        const rows = templateRows([orgTpl, mine, groupTpl], null);
        expect(rows.map((r) => [r.template.id, r.editable])).toEqual([
            ['u1', true],
            ['g1', false],
            ['o1', false],
        ]);
    });

    it('gives an admin every org template, also of groups they are not in', () => {
        const otherGroup = { id: 'g2', name: 'Other group', scope: 'group' as const, groupId: 'x' };
        const rows = templateRows([mine, orgTpl], [orgTpl, otherGroup]);
        expect(rows.map((r) => [r.template.id, r.editable])).toEqual([
            ['u1', true],
            ['o1', true],
            ['g2', true],
        ]);
    });
});
