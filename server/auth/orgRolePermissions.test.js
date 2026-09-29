const test = require('node:test');
const assert = require('node:assert');

const { SYSTEM_PERMISSIONS, getOrgRolePermissions } = require('./permissions');

/*
 * config/orgRoles.json is what an organisation's Roles screen shows and what
 * the permission resolver actually applies, so a typo there is invisible: the
 * id simply never matches a gate, and the section it was meant to open stays
 * dark for everyone holding that role. These cases make the file answer for
 * itself.
 */

const KNOWN_IDS = new Set(SYSTEM_PERMISSIONS.map((p) => p.id));

test('every permission a role grants exists in SYSTEM_PERMISSIONS', () => {
    const mapping = getOrgRolePermissions();
    assert.ok(Object.keys(mapping).length > 0, 'orgRoles.json failed to load');
    // The role id doubles as a marker permission the server checks by name
    // (`org_admin`, `dpo`, …), and those are legitimately not in
    // SYSTEM_PERMISSIONS. Taken from the file's own keys rather than the
    // OrgRoles enum, which does not carry isms_auditor.
    const ROLE_MARKERS = new Set(Object.keys(mapping));
    for (const [role, perms] of Object.entries(mapping)) {
        for (const id of perms) {
            assert.ok(
                KNOWN_IDS.has(id) || ROLE_MARKERS.has(id),
                `role '${role}' grants unknown permission '${id}'`,
            );
        }
    }
});

test('every Studio section has a permission a role can grant', () => {
    // One per section in agent-hub/src/components/admin/Studio/studioApps.jsx,
    // plus the three sidebar rows that are not Studio sections. A section whose
    // permission nobody holds is a section nobody can reach, so each must be
    // granted by at least one role.
    const STUDIO_PERMISSIONS = [
        'manage_agents', 'manage_skills', 'manage_knowledge', 'use_meeting_notes',
        'use_automations', 'use_datatables', 'use_webpages', 'manage_apps', 'use_solutions',
        'use_approvals', 'use_apps', 'use_forms', 'use_notebooks',
    ];
    const mapping = getOrgRolePermissions();
    const granted = new Set(Object.values(mapping).flat());
    for (const id of STUDIO_PERMISSIONS) {
        assert.ok(KNOWN_IDS.has(id), `'${id}' is missing from SYSTEM_PERMISSIONS`);
        assert.ok(granted.has(id), `no org role grants '${id}' — the section is unreachable`);
    }
});

test('the Studio grants match what each role could reach before they existed', () => {
    // The permission layer shipped with grants chosen to change nothing: the
    // three builder roles could open every licensed Studio section, and
    // everybody could reach Approvals, the Apps directory and Forms. Anyone
    // rebalancing these on purpose should have to edit this list too.
    const mapping = getOrgRolePermissions();
    const has = (role, id) => (mapping[role] || []).includes(id);

    const BUILDER_ROLES = ['org_admin', 'agent_admin', 'agent_editor'];
    const BUILDER_PERMISSIONS = [
        'manage_agents', 'manage_skills', 'manage_knowledge', 'use_automations',
        'use_webpages', 'manage_apps', 'use_solutions', 'use_meeting_notes', 'use_datatables',
    ];
    for (const role of BUILDER_ROLES) {
        for (const id of BUILDER_PERMISSIONS) {
            assert.ok(has(role, id), `${role} lost '${id}'`);
        }
    }

    // The consumer rows are not a builder privilege — an approver is usually
    // exactly the person who builds nothing.
    for (const role of Object.keys(mapping)) {
        for (const id of ['use_approvals', 'use_apps', 'use_forms']) {
            assert.ok(has(role, id), `${role} cannot reach '${id}'`);
        }
    }

    // …and the compliance roles gained nothing else: they could not open
    // Studio before and must not be able to now.
    for (const role of ['dpo', 'isms_auditor']) {
        for (const id of BUILDER_PERMISSIONS) {
            assert.ok(!has(role, id), `${role} unexpectedly grants '${id}'`);
        }
    }
});
