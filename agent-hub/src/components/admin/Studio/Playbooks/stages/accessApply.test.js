// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { accessSummary, applyAccessPlan, mergedMapping, mergedRoles, mergedTables, publishBody } from './accessApply';

const t = (k, f, v) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);

/**
 * An approved plan becomes the smallest set of writes — in the only order
 * that works, and never before Approve (the stage owns that gate; this owns
 * what happens after it).
 */
describe('accessApply — what an approved plan actually writes', () => {
    it('merges into what the app already has instead of replacing it', () => {
        const roles = mergedRoles([{ key: 'viewer', label: 'Viewer' }], { roles: [{ key: 'approver', label: 'Approver' }, { key: 'viewer', label: 'Dupe' }] });
        expect(roles).toEqual([{ key: 'viewer', label: 'Viewer' }, { key: 'approver', label: 'Approver' }]);
        const mapping = mergedMapping({ default: 'app', byGroup: { g_old: 'viewer' } }, { defaultRole: 'approver', byGroup: { g_new: 'approver' } });
        expect(mapping).toEqual({ default: 'approver', byGroup: { g_old: 'viewer', g_new: 'approver' } });
        // Nothing said about the default leaves it where it was.
        expect(mergedMapping({ default: 'viewer', byGroup: {} }, {}).default).toBe('viewer');
    });

    it('the audience write says exactly what the plan says, and nothing when it is silent', () => {
        expect(publishBody({ audience: { kind: 'private' } })).toEqual({ isPublished: false });
        expect(publishBody({ audience: { kind: 'organisation' } })).toEqual({ isPublished: true, sharedGroups: [] });
        expect(publishBody({ audience: { kind: 'groups', groupIds: ['g1', 'g2'] } })).toEqual({ isPublished: true, sharedGroups: ['g1', 'g2'] });
        expect(publishBody({ audience: null })).toBeNull();
        expect(publishBody({ audience: { kind: 'groups', groupIds: [] } })).toBeNull();
    });

    it('roles before people before the audience — a member cannot hold a role that does not exist yet', async () => {
        const order = [];
        const deps = {
            saveRoles: vi.fn(async () => order.push('roles')),
            assignMember: vi.fn(async (u) => order.push(`member:${u}`)),
            publish: vi.fn(async () => order.push('audience')),
        };
        const plan = {
            roles: [{ key: 'approver', label: 'Approver' }],
            defaultRole: 'app',
            byGroup: { g1: 'approver' },
            members: [{ userId: 'u1', roleKey: 'approver' }, { userId: 'u2', roleKey: 'app' }],
            audience: { kind: 'organisation' },
        };
        const out = await applyAccessPlan(plan, { roles: [], roleMapping: { default: 'app', byGroup: {} } }, deps);
        expect(order).toEqual(['roles', 'member:u1', 'member:u2', 'audience']);
        expect(out.failed).toEqual([]);
        expect(deps.saveRoles).toHaveBeenCalledWith([{ key: 'approver', label: 'Approver' }], { default: 'app', byGroup: { g1: 'approver' } }, undefined);
    });

    it('one failure does not cost the rest, and it is reported by name', async () => {
        const deps = {
            saveRoles: vi.fn(async () => {}),
            assignMember: vi.fn(async (u) => { if (u === 'u1') throw new Error('gone'); }),
            publish: vi.fn(async () => {}),
        };
        const out = await applyAccessPlan(
            { roles: [{ key: 'r', label: 'R' }], members: [{ userId: 'u1', name: 'Jan' }, { userId: 'u2', name: 'Ann' }], audience: { kind: 'private' } },
            { roles: [], roleMapping: null },
            deps,
        );
        expect(out.failed.map((f) => f.what)).toEqual(['member:Jan']);
        expect(out.applied).toEqual(['roles', 'member:u2', 'audience']);
        expect(deps.publish).toHaveBeenCalledWith({ isPublished: false });
    });

    it('a plan that touches nothing writes nothing', async () => {
        const deps = { saveRoles: vi.fn(), assignMember: vi.fn(), publish: vi.fn() };
        const out = await applyAccessPlan({ roles: [], members: [], byGroup: {}, audience: null }, { roles: [], roleMapping: null }, deps);
        expect(out).toEqual({ applied: [], failed: [], nc: null });
        expect(deps.saveRoles).not.toHaveBeenCalled();
        expect(deps.publish).not.toHaveBeenCalled();
        expect(accessSummary({ members: [], roles: [] }, t)).toMatch(/Nothing changed/);
    });

    it('the summary says what landed', () => {
        expect(accessSummary({ audience: { kind: 'groups', groupNames: ['Finance', 'Ops'] }, roles: [{ key: 'a' }], members: [{ userId: 'u1' }] }, t))
            .toBe('Shared with Finance, Ops · 1 new role(s) · 1 person/people given a role.');
        expect(accessSummary({ audience: { kind: 'private' }, roles: [], members: [] }, t)).toBe('Shared with nobody but you.');
    });

    it('a role with a row rule saves the rule ON the table, in the SAME write as the role', async () => {
        // Two writes would leave a window in which the role exists and sees
        // everything — the one thing a per-supplier role must never do.
        const deps = { saveRoles: vi.fn(async () => {}), assignMember: vi.fn(), publish: vi.fn() };
        const plan = {
            roles: [{ key: 'supplier_acme', label: 'ACME', scope: { column: 'supplier', value: 'ACME' } }],
            tableRules: [{ tableId: 'tbl_model01', roleKey: 'supplier_acme', expr: 'record.supplier == "ACME"' }],
            members: [], byGroup: {}, audience: null,
        };
        const tables = [
            { id: 'tbl_model01', key: 'invoices', access: { default: 'app', roles: {}, rowFilters: { old_role: 'record.x == 1' } } },
            { id: 'tbl_other', key: 'other', access: { default: 'app' } },
        ];
        const out = await applyAccessPlan(plan, { roles: [], roleMapping: null, tables }, deps);
        expect(out.applied).toEqual(['roles', 'rules:1']);
        const [, , savedTables] = deps.saveRoles.mock.calls[0];
        expect(savedTables[0].access.rowFilters).toEqual({ old_role: 'record.x == 1', supplier_acme: 'record.supplier == "ACME"' });
        expect(savedTables[1]).toEqual(tables[1], 'a table with no rule is handed back untouched');
    });

    it('the Nextcloud menu goes on AFTER the publish, and only for a published app', async () => {
        // The endpoint answers 409 not_published when the app is still a
        // draft, which is why the order is fixed rather than convenient.
        const order = [];
        const deps = {
            saveRoles: vi.fn(), assignMember: vi.fn(),
            publish: vi.fn(async () => order.push('publish')),
            setNextcloudMenu: vi.fn(async () => { order.push('nc'); return { ncSync: 'synced', ncConnected: true }; }),
        };
        const out = await applyAccessPlan(
            { roles: [], members: [], byGroup: {}, audience: { kind: 'organisation' }, nextcloudMenu: true },
            { roles: [], roleMapping: null, nextcloudMenu: false },
            deps,
        );
        expect(order).toEqual(['publish', 'nc']);
        expect(deps.setNextcloudMenu).toHaveBeenCalledWith(true);
        expect(out.applied).toEqual(['audience', 'nc_menu']);
        expect(out.nc).toEqual({ ncSync: 'synced', ncConnected: true });
    });

    it('no menu call when the app stays private, when the flag is unchanged, or when the publish failed', async () => {
        const mk = () => ({ saveRoles: vi.fn(), assignMember: vi.fn(), publish: vi.fn(async () => {}), setNextcloudMenu: vi.fn(async () => ({})) });
        const base = { roles: [], members: [], byGroup: {} };

        const priv = mk();
        await applyAccessPlan({ ...base, audience: { kind: 'private' }, nextcloudMenu: true }, { roles: [], roleMapping: null }, priv);
        expect(priv.setNextcloudMenu).not.toHaveBeenCalled();

        const same = mk();
        await applyAccessPlan({ ...base, audience: { kind: 'organisation' }, nextcloudMenu: true }, { roles: [], roleMapping: null, nextcloudMenu: true }, same);
        expect(same.setNextcloudMenu).not.toHaveBeenCalled();

        const broken = mk();
        broken.publish = vi.fn(async () => { throw new Error('422'); });
        const out = await applyAccessPlan({ ...base, audience: { kind: 'organisation' }, nextcloudMenu: true }, { roles: [], roleMapping: null }, broken);
        expect(broken.setNextcloudMenu).not.toHaveBeenCalled();
        expect(out.failed.map((f) => f.what)).toEqual(['audience']);
    });

    it('a Nextcloud that will not take the icon never costs the audience', async () => {
        const deps = {
            saveRoles: vi.fn(), assignMember: vi.fn(), publish: vi.fn(async () => {}),
            setNextcloudMenu: vi.fn(async () => { throw new Error('unreachable'); }),
        };
        const out = await applyAccessPlan(
            { roles: [], members: [], byGroup: {}, audience: { kind: 'organisation' }, nextcloudMenu: true },
            { roles: [], roleMapping: null }, deps,
        );
        expect(out.applied).toEqual(['audience']);
        expect(out.failed.map((f) => f.what)).toEqual(['nc_menu']);
    });

    it('the summary says the app is in the Nextcloud menu', () => {
        expect(accessSummary({ audience: { kind: 'organisation' }, nextcloudMenu: true, roles: [], members: [] }, t))
            .toBe('Shared with the whole organisation · in the Nextcloud app menu.');
        // Ticked but never shared: the menu clause has nothing to stand on.
        expect(accessSummary({ audience: { kind: 'private' }, nextcloudMenu: true, roles: [], members: [] }, t))
            .toBe('Shared with nobody but you.');
    });

    it('mergedTables leaves everything alone when there is nothing to write', () => {
        const tables = [{ id: 't1', access: { default: 'app' } }];
        expect(mergedTables(tables, { tableRules: [] })).toBe(tables);
        expect(mergedTables(tables, {})).toBe(tables);
        // A rule for a table that is not in the model matches nothing.
        expect(mergedTables(tables, { tableRules: [{ tableId: 'ghost', roleKey: 'r', expr: 'x' }] })).toEqual(tables);
    });

    it('the summary counts the roles that see only their own rows', () => {
        expect(accessSummary({ roles: [{ key: 'a' }, { key: 'b' }], tableRules: [{ roleKey: 'a' }, { roleKey: 'b' }], members: [] }, t))
            .toBe('2 new role(s) · 2 of them see only their own rows.');
    });
});
