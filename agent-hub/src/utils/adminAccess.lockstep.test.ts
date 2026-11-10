// @vitest-environment node
//
// Lockstep tripwire: the SPA's isOrgAdminRole must give the same answer as the
// server's (server/auth/permissions.js) for every role string, or the
// profile menu offers (or hides) a dashboard the server then treats differently.

import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';
import { isOrgAdminRole } from './adminAccess';

const require = createRequire(import.meta.url);
const server = require('../../../server/auth/permissions.js');

const ROLES: (string | null | undefined)[] = ['org_admin', 'admin', 'agent_admin', 'agent_editor', 'member', 'dpo', 'isms_auditor', '', 'ORG_ADMIN', null, undefined];

describe('isOrgAdminRole lockstep with the server', () => {
    it.each(ROLES)('agrees on %s', (role) => {
        expect(isOrgAdminRole(role)).toBe(server.isOrgAdminRole(role));
    });
});
