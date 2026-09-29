/**
 * ISO 27001 A.5.15 / A.5.18 / A.8.3 — Access control is centrally defined and
 * machine-checked.
 *
 * Three signals, all static-architecture truth read from the running build:
 *   1. REGISTRY — auth/accessRegistry.js loads and declares at least one route
 *      with a five-valued `enforcement`. This is the machine-readable
 *      access-control matrix the drift test verifies.
 *   2. DRIFT TEST — auth/accessRegistry.drift.test.js exists on disk. Without
 *      it the registry is documentation, not a verified artefact → warn.
 *   3. ROLES — config/orgRoles.json loads and every role grants at least one
 *      permission (the role→permission mapping behind requirePermission()).
 */

const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', '..', '..', 'auth');
const ORG_ROLES_PATH = path.join(__dirname, '..', '..', '..', 'config', 'orgRoles.json');

module.exports = {
    id: 'ISO27001-A.5.15-access-control',
    regulation: 'ISO27001',
    article: 'A.5.15',
    controls: ['A.5.15', 'A.5.18', 'A.8.3'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(i)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_access_control.title',
    descriptionKey: 'compliance.checks.iso_access_control.desc',
    remediationKey: 'compliance.checks.iso_access_control.fix',
    remediationLink: 'admin/security/users',
    async evaluate() {
        let registry;
        try {
            registry = require(path.join(AUTH_DIR, 'accessRegistry'));
        } catch (e) {
            return {
                status: 'fail',
                evidence: { registry_loaded: false, load_error: e.message },
                details: 'The access-control registry (auth/accessRegistry.js) failed to load — route requirements are no longer machine-readable.',
            };
        }

        const routes = (registry.routes && typeof registry.routes === 'object') ? registry.routes : {};
        const declaredRoutes = Object.keys(routes);
        const enforcement = { middleware: 0, handler: 0, scoped: 0, public: 0, other: 0 };
        for (const key of declaredRoutes) {
            const mode = routes[key] && routes[key].enforcement;
            if (Object.prototype.hasOwnProperty.call(enforcement, mode)) enforcement[mode]++;
            else enforcement.other++;
        }
        const untriagedCount = Array.isArray(registry.untriaged) ? registry.untriaged.length : 0;

        let roles = {};
        let rolesError = null;
        try {
            roles = JSON.parse(fs.readFileSync(ORG_ROLES_PATH, 'utf-8'));
        } catch (e) {
            rolesError = e.message;
        }
        const roleNames = Object.keys(roles);
        const emptyRoles = roleNames.filter(r =>
            !Array.isArray(roles[r] && roles[r].permissions) || roles[r].permissions.length === 0);

        const driftTestPresent = fs.existsSync(path.join(AUTH_DIR, 'accessRegistry.drift.test.js'));

        const evidence = {
            registry_loaded: true,
            declared_routes: declaredRoutes.length,
            enforcement,
            untriaged_routes: untriagedCount,
            drift_test_present: driftTestPresent,
            org_roles: roleNames.length,
            roles_without_permissions: emptyRoles.length,
        };

        if (declaredRoutes.length === 0) {
            return {
                status: 'fail',
                evidence,
                details: 'The access-control registry declares no routes — the access-control matrix is empty and nothing is machine-checked.',
            };
        }
        if (rolesError || roleNames.length === 0) {
            if (rolesError) evidence.roles_error = rolesError;
            return {
                status: 'fail',
                evidence,
                details: 'The role definitions (config/orgRoles.json) could not be loaded — permission grants have no central source of truth.',
            };
        }
        if (!driftTestPresent) {
            return {
                status: 'warn',
                evidence,
                details: `${declaredRoutes.length} routes are declared but the drift test (auth/accessRegistry.drift.test.js) is missing — declarations are no longer verified against the real middleware chains.`,
            };
        }
        if (emptyRoles.length > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${emptyRoles.length} role(s) in orgRoles.json grant no permissions — remove or complete them so the role model stays meaningful.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `${declaredRoutes.length} route declarations (${enforcement.middleware} machine-verified middleware gates), ${untriagedCount} known-untriaged, ${roleNames.length} org roles defined; the drift test keeps declarations honest.`,
        };
    },
};
