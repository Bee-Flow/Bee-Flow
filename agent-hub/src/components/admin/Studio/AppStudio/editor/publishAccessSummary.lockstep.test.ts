import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_KINDS, ownerRunFeeds, PUBLIC_ROLE_KEY, resolveScope } from './publishAccessSummary';
import type { AccessTable } from './publishAccessSummary';

const require = createRequire(import.meta.url);
const connectors = require('../../../../../../../server/appStudio/connectors/shared.js');
const accessFilter = require('../../../../../../../server/core/dataEngine/accessFilter.js');
const dataModel = require('../../../../../../../server/appStudio/dataModel.js');

/**
 * The publish summary mirrors two server decisions by hand, so it is pinned to
 * them here: which connectors fetch on the owner's credentials (every kind the
 * connector runtime runs), and what a role may do in a table.
 */

describe('publish summary — connector kinds', () => {
    it('knows every kind the connector runtime runs', () => {
        expect([...CONNECTOR_KINDS].sort()).toEqual([...connectors.CONNECTOR_KINDS].sort());
    });

    it('lists an owner-run connector of each kind, and none that runs as the viewer', () => {
        const model = {
            connectors: [
                ...connectors.CONNECTOR_KINDS.map((kind: string) => ({ id: `c_${kind}`, kind, name: kind })),
                { id: 'c_viewer', kind: 'mailbox', name: 'Own inbox', runAs: 'viewer' },
                { id: 'c_bad', kind: 'telepathy', name: 'Unknown' },
            ],
        };
        expect(ownerRunFeeds(model).sort()).toEqual([...connectors.CONNECTOR_KINDS].sort());
    });
});

describe('publish summary — table scope agrees with the server', () => {
    const tables: AccessTable[] = [
        {},
        { access: { default: 'app' } },
        { access: { default: 'owner' } },
        { access: { default: 'role' } },
        { access: { default: 'none' } },
        { access: { default: 'app', roles: { member: { read: 'own', update: true, delete: false, create: 'own' } } } },
        { access: { default: 'app', roles: { public: { create: true, read: 'own' } } } },
        { access: { default: 'owner', roles: { public: { read: 'all' } } } },
    ];
    const roles = ['owner', null, 'member', 'viewer', PUBLIC_ROLE_KEY];

    it('names the reserved role as the server does', () => {
        expect(PUBLIC_ROLE_KEY).toBe(dataModel.PUBLIC_ROLE_KEY);
    });

    for (const action of ['read', 'update', 'delete', 'create']) {
        it(`resolves ${action} the same way for every role`, () => {
            for (const [i, table] of tables.entries()) {
                for (const role of roles) {
                    expect(resolveScope(table, role, action), `table ${i}, role ${role}`).toEqual(accessFilter.resolveScope(table, role, action));
                }
            }
        });
    }
});
