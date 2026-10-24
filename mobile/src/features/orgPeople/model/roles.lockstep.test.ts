/**
 * The role and permission copy in roles.ts is the web's (a generated copy of
 * agent-hub/src/config/orgRoles.ts under ../mirror), and the role ids are the
 * server's (server/config/orgRoles.json).
 */

import fs from 'node:fs';
import path from 'node:path';

import { ORG_ROLE_IDS, PERMISSION_IDS, permissionCopy, roleCopy } from './roles';
import { ORG_ROLES, PERMISSION_CATALOG } from '../mirror/orgRoles';


const REPO = path.resolve(__dirname, '../../../../..');
const english = (_key: string, fallback: string) => fallback;

describe('roles.ts in lockstep with the web and the server', () => {
    it('lists the web’s ORG_ROLES ids, in its order', () => {
        expect([...ORG_ROLE_IDS]).toEqual(ORG_ROLES.map((r) => r.id));
    });

    it('says each role the way the web does', () => {
        for (const r of ORG_ROLES) {
            expect(roleCopy(r.id, english)).toEqual({ name: r.name, description: r.description });
        }
    });

    it('matches the server’s role model', () => {
        const server = JSON.parse(fs.readFileSync(path.join(REPO, 'server/config/orgRoles.json'), 'utf8')) as Record<
            string,
            unknown
        >;
        expect([...ORG_ROLE_IDS].sort()).toEqual(Object.keys(server).sort());
    });

    it('carries copy for every PERMISSION_CATALOG id, in its order', () => {
        expect(PERMISSION_IDS).toEqual(Object.keys(PERMISSION_CATALOG));
    });

    it('says each permission the way the web does', () => {
        for (const [id, c] of Object.entries(PERMISSION_CATALOG)) {
            expect(permissionCopy(id, english)).toEqual({ id, label: c.label, description: c.desc });
        }
    });
});
