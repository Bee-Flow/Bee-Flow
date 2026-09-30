/**
 * The access phase's words and writes, held to the web's accessView.js and
 * accessApply.js on the same plans: where the app stands, every sentence the
 * gate lists before Approve, why Approve is grey, the publish body and the
 * summary the phase lands with. Also what the phone applies itself, and what
 * it leaves to the web.
 *
 * When this fails, the web side changed: update accessView.ts / accessApply.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import { accessSummary, applyAccessPlan, needsModelWrite, publishBody } from './accessApply';
import { ASK_EXAMPLES, currentAccess, plannedChanges, roleWords, ruleWords, whyDisabled } from './accessView';
import type { AccessPlan } from './types';

const DIR = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Playbooks/stages');
const describeIfWeb = fs.existsSync(path.join(DIR, 'accessView.js')) ? describe : describe.skip;

type Fn = (...args: unknown[]) => unknown;
const t = (_k: string, en: string, p: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, n: string) => (n in p ? String(p[n]) : m));

const plan = (over: Partial<AccessPlan> = {}): AccessPlan => ({
    note: '', audience: null, roles: [], tableRules: [], defaultRole: null, byGroup: {}, members: [], unresolved: [], empty: false, ...over,
});

const PLANS: AccessPlan[] = [
    plan({ empty: true }),
    plan({ audience: { kind: 'private', groupIds: [], groupNames: [] } }),
    plan({ audience: { kind: 'organisation', groupIds: [], groupNames: [] }, members: [{ userId: 'u1', roleKey: 'app', name: 'Ann' }] }),
    plan({ audience: { kind: 'groups', groupIds: ['g1', 'g2'], groupNames: [] } }),
    plan({ audience: { kind: 'groups', groupIds: ['g1'], groupNames: ['Finance'] } }),
    plan({ audience: { kind: 'groups', groupIds: [], groupNames: [] } }),
    plan({
        roles: [{ key: 'supplier_acme', label: 'ACME' }, { key: 'viewer', label: 'Viewer' }],
        tableRules: [{ tableId: 't1', roleKey: 'supplier_acme', expr: 'record.supplier == "ACME"' }],
        byGroup: { g1: 'viewer', g9: 'member' },
        members: [{ userId: 'u2', roleKey: 'supplier_acme', name: '' }, { userId: 'u3', roleKey: 'approver', name: 'Bo' }],
    }),
];

const GROUPS = [{ id: 'g1', name: 'Finance' }, { id: 'g2', name: 'Sales' }];
const USERS = [{ id: 'u2', name: 'Cas' }];
const ROLES = [{ key: 'approver', label: 'Approver' }];

describeIfWeb('the access words match the web', () => {
    const view = () => loadWebModule<Record<string, Fn>>(path.join(DIR, 'accessView.js'));
    const apply = () => loadWebModule<Record<string, Fn>>(path.join(DIR, 'accessApply.js'));

    it('says where the app stands the same way', () => {
        for (const app of [null, { isPublished: false, sharedGroups: [] }, { isPublished: true, sharedGroups: [] }, { isPublished: true, sharedGroups: ['g1'] }, { isPublished: true, sharedGroups: ['g1', 'g2'] }]) {
            for (const n of [0, 1, 3]) {
                const theirs = view().currentAccess!(app, Array.from({ length: n }), t);
                expect(currentAccess(app, n, t)).toEqual(theirs);
            }
        }
    });

    it('lists the same changes and the same reason Approve is grey', () => {
        for (const p of PLANS) {
            for (const app of [null, { id: 'a1' }]) {
                const ctx = { groups: GROUPS, users: USERS, app, roles: ROLES };
                expect(plannedChanges(p, ctx, t)).toEqual(view().plannedChanges!(p, ctx, t));
            }
            expect(whyDisabled(p, t)).toBe(view().whyDisabled!(p, t));
        }
        expect(whyDisabled(null, t)).toBe(view().whyDisabled!(null, t));
        expect(ASK_EXAMPLES).toEqual(view().ASK_EXAMPLES);
    });

    it('words roles and rules the same way', () => {
        for (const expr of ['record.supplier == "ACME"', 'record.x > 3', '', null]) expect(ruleWords(expr, t)).toBe(view().ruleWords!(expr, t));
        const ctx = { roles: ROLES, planRoles: [{ key: 'scoped', label: 'S', scope: { column: 'city', value: 'Delft' } }], planRules: [{ roleKey: 'ruled', expr: 'record.a == "b"' }] };
        for (const key of [null, 'app', 'member', 'scoped', 'ruled', 'approver', 'unknown']) {
            expect(roleWords(key, ctx, t)).toBe(view().roleWords!(key, { ...ctx, tables: [] }, t));
        }
    });

    it('publishes and sums up the same way', () => {
        for (const p of PLANS) {
            expect(publishBody(p)).toEqual(apply().publishBody!(p));
            expect(accessSummary(p, t)).toBe(apply().accessSummary!(p, t));
        }
    });
});

describe('what the phone applies', () => {
    it('leaves any change to the app’s data model to the web', () => {
        expect(needsModelWrite(PLANS[2] as AccessPlan)).toBe(false);
        expect(needsModelWrite(PLANS[6] as AccessPlan)).toBe(true);
        expect(needsModelWrite(plan({ defaultRole: 'member' }))).toBe(true);
    });

    it('adds the people, then publishes, and one failure never stops the rest', async () => {
        const calls: string[] = [];
        const out = await applyAccessPlan(
            plan({ audience: { kind: 'groups', groupIds: ['g1'], groupNames: ['Finance'] }, members: [{ userId: 'u1', roleKey: 'app', name: 'Ann' }, { userId: 'u2', roleKey: 'app', name: '' }] }),
            {
                assignMember: async (userId) => {
                    calls.push(`member:${userId}`);
                    if (userId === 'u1') throw new Error('nope');
                },
                publish: async (body) => {
                    calls.push(`publish:${JSON.stringify(body)}`);
                },
            },
        );
        expect(calls).toEqual(['member:u1', 'member:u2', 'publish:{"isPublished":true,"sharedGroups":["g1"]}']);
        expect(out.applied).toEqual(['member:u2', 'audience']);
        expect(out.failed.map((f) => f.what)).toEqual(['member:Ann']);
    });
});
