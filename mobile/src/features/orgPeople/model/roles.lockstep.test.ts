/**
 * The role and permission copy in roles.ts is the web's
 * (agent-hub/src/config/orgRoles.js), and the role ids are the server's
 * (server/config/orgRoles.json). Read as text: when either side changes,
 * port the change here rather than loosening this test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ORG_ROLE_IDS, PERMISSION_IDS } from './roles';

const REPO = path.resolve(__dirname, '../../../../..');
const web = fs.readFileSync(path.join(REPO, 'agent-hub/src/config/orgRoles.js'), 'utf8');

/** From `export const NAME =` to its closing bracket at column 0. */
function block(name: string, close: '};' | '];'): string {
    const start = web.indexOf(`export const ${name} =`);
    if (start < 0) throw new Error(`${name} not found in orgRoles.js`);
    return web.slice(start, web.indexOf(`\n${close}`, start));
}

describe('roles.ts in lockstep with the web and the server', () => {
    it('lists the web’s ORG_ROLES ids, in its order', () => {
        const ids = [...block('ORG_ROLES', '];').matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]);
        expect([...ORG_ROLE_IDS]).toEqual(ids);
    });

    it('matches the server’s role model', () => {
        const server = JSON.parse(fs.readFileSync(path.join(REPO, 'server/config/orgRoles.json'), 'utf8')) as Record<
            string,
            unknown
        >;
        expect([...ORG_ROLE_IDS].sort()).toEqual(Object.keys(server).sort());
    });

    it('carries copy for every PERMISSION_CATALOG id, in its order', () => {
        const ids = [...block('PERMISSION_CATALOG', '};').matchAll(/^\s{4}(\w+): \{ label:/gm)].map((m) => m[1]);
        expect(PERMISSION_IDS).toEqual(ids);
    });
});
