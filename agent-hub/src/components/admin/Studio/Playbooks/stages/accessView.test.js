// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    currentAccess, peopleToShow, plannedChanges, roleOptions, roleWords, ruleWords, whyDisabled,
} from './accessView';

const t = (k, f, v) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);

describe('accessView — what the access phase says', () => {
    it('says where the app stands before anything on the screen happens', () => {
        const priv = currentAccess({ isPublished: false }, [], t);
        expect(priv.who).toBe('Only you can open it');
        expect(priv.namedLine).toBe('Nobody holds a named role yet');
        expect(priv.tone).toBe('private');
        const open = currentAccess({ isPublished: true, sharedGroups: [] }, [{ userId: 'u1' }, { userId: 'u2' }], t);
        expect(open.who).toBe('Everyone in the organisation can open it');
        expect(open.namedLine).toBe('2 people hold a named role');
        expect(open.tone).toBe('open');
        expect(currentAccess({ isPublished: true, sharedGroups: ['g1'] }, [], t).who).toBe('1 group can open it');
        // No app row yet is not an excuse to claim anything.
        expect(currentAccess(null, [], t).tone).toBe('private');
    });

    it('a role says what it lets someone SEE, not just its key', () => {
        const ctx = {
            roles: [{ key: 'approver', label: 'Approver' }],
            planRoles: [{ key: 'supplier_acme', label: 'ACME', scope: { column: 'supplier', value: 'ACME' } }],
            tables: [{ id: 't1', access: { rowFilters: { viewer_nl: 'record.country == "NL"' } } }],
            planRules: [],
        };
        expect(roleWords('', ctx, t)).toBe('No access');
        expect(roleWords('app', ctx, t)).toBe('Can use the app');
        // The row rule is the whole point of a per-supplier role.
        expect(roleWords('supplier_acme', ctx, t)).toBe('sees only rows where supplier is ACME');
        // …including one already on the model, which was visible nowhere.
        expect(roleWords('viewer_nl', ctx, t)).toBe('sees only rows where country is NL');
        expect(roleWords('approver', ctx, t)).toBe('Approver');
        expect(ruleWords('record.supplier == "Bakker"', t)).toBe('sees only rows where supplier is Bakker');
        // Anything the grammar does not cover is shown as it is, never faked.
        expect(ruleWords('viewer.role == "admin"', t)).toBe('viewer.role == "admin"');
    });

    it('the roles on offer are every real one, once', () => {
        const out = roleOptions({ roles: [{ key: 'approver', label: 'Approver' }], planRoles: [{ key: 'approver', label: 'Dupe' }, { key: 'acme', label: 'ACME' }] }, t);
        expect(out.map((r) => r.key)).toEqual(['app', 'approver', 'acme', 'member']);
    });

    it('lists every change Approve would make, one line each', () => {
        const plan = {
            audience: { kind: 'groups', groupIds: ['g_fin'], groupNames: ['Finance'] },
            roles: [{ key: 'acme', label: 'ACME' }],
            tableRules: [{ tableId: 't1', roleKey: 'acme', expr: 'record.supplier == "ACME"' }],
            byGroup: { g_fin: 'approver' },
            members: [{ userId: 'u_ann', roleKey: 'approver', name: 'Ann Blok' }],
            nextcloudMenu: true,
        };
        const out = plannedChanges(plan, { groups: [{ id: 'g_fin', name: 'Finance' }], users: [], app: { id: 'a' } }, t).map((c) => c.words);
        expect(out).toEqual([
            'Publish it to Finance.',
            'Create the role "ACME", which sees only rows where supplier is ACME.',
            'Give Finance the role "approver".',
            'Give Ann Blok the role "approver".',
            'Put the app in your Nextcloud app menu.',
            'Publishing takes a copy of the app exactly as it stands now.',
        ]);
        // Private takes it off sharing, and the menu clause has nothing to stand on.
        const priv = plannedChanges({ audience: { kind: 'private' }, nextcloudMenu: true }, { app: { id: 'a' } }, t).map((c) => c.words);
        expect(priv).toEqual(['Take the app off sharing — only you can open it.']);
        expect(plannedChanges({}, {}, t)).toEqual([]);
    });

    it('says WHY Approve is grey — a dead button with no reason is a dead end', () => {
        expect(whyDisabled({ empty: true }, t)).toBe('Choose who can open the app, or say it in a sentence above.');
        expect(whyDisabled({ empty: false, audience: { kind: 'groups', groupIds: [] } }, t)).toBe('Pick at least one group, or choose a different audience.');
        expect(whyDisabled({ empty: false, audience: { kind: 'organisation' } }, t)).toBeNull();
    });

    it('shows the people who matter, and finds the rest by name', () => {
        const users = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}`, email: `p${i}@x.nl` }));
        // Nobody has a role yet: a handful, not forty selects.
        expect(peopleToShow(users, {}).length).toBe(8);
        // Someone does: exactly them.
        expect(peopleToShow(users, { members: [{ userId: 'u7' }] }).map((u) => u.id)).toEqual(['u7']);
        expect(peopleToShow(users, { plan: { members: [{ userId: 'u3' }] } }).map((u) => u.id)).toEqual(['u3']);
        // And a search reaches the whole directory, by name or by e-mail.
        expect(peopleToShow(users, { query: 'person 12' }).map((u) => u.id)).toEqual(['u12']);
        expect(peopleToShow(users, { query: 'p31@' }).map((u) => u.id)).toEqual(['u31']);
        expect(peopleToShow(users, { query: 'nobody' })).toEqual([]);
    });
});
