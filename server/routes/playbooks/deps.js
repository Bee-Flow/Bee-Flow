/**
 * WHAT THIS ROUTER REACHES FOR — one lazy entry per module, so requiring the
 * router costs nothing and a test can hand the whole graph in instead
 * (`createPlaybooksRouter(deps)`).
 *
 * Two entries are deliberate GLUE and belong to the route rather than to the
 * feature: `playbooks/` may require neither `appStudio/` nor `compliance/`
 * (one feature never requires another — layering.test.js), and a route may
 * require both.
 */

'use strict';

const { makeLazyDeps } = require('../studio/shared');

function makeDefaultDeps() {
    return makeLazyDeps({
        playbookStore: () => require('../../stores/playbookStore'),
        datatableStore: () => require('../../stores/datatableStore'),
        datatableDbStore: () => require('../../stores/datatableDbStore'),
        automationStore: () => require('../../stores/automationStore'),
        studioAppStore: () => require('../../stores/studioAppStore'),
        userStore: () => require('../../stores/userStore'),
        db: () => require('../../db'),
        runner: () => require('../../core/automationRunner'),
        entitlements: () => require('../../core/entitlements/entitlements'),
        // Which tiers a person may use: the list the new-playbook dialog and
        // both builders offer. Every tier this router runs on is measured
        // against it (phaseFlow.tierFor / phaseTier).
        tierAccessFor: () => require('../../core/entitlements/tierAccess').tierAccessFor,
        permissions: () => require('../../auth/permissions'),
        datatableAccess: () => require('../../auth/datatableAccess'),
        normalizeFields: () => require('../../core/dataEngine/dataModel/datatableFields').normalizeFields,
        migrationPlan: () => require('../../core/dataEngine/dataModel/migrationPlan').migrationPlan,
        ddlForTable: () => require('../../core/dataEngine/dataModel/ddl').ddlForTable,
        assertDatatableQuota: () => require('../../core/dataEngine/datatableLimits').assertDatatableQuota,
        recipes: () => require('../../playbooks/recipes'),
        recipeDoc: () => require('../../playbooks/recipeDoc'),
        runDesignPhase: () => require('../../playbooks/phases/designPhase').runDesignPhase,
        datatableRuntime: () => require('../../core/dataEngine/datatableRuntime'),
        composeRecipe: () => require('../../playbooks/composeRecipe').composeRecipe,
        planAccess: () => require('../../playbooks/accessPlan').planAccess,
        planResolve: () => require('../../playbooks/resolvePlan').planResolve,
        datatableAccessPlan: () => require('../../auth/datatableAccess'),
        rlsGateway: () => require('../../appStudio/rlsGateway'),
        runCompliancePhase: () => require('../../playbooks/phases/compliancePhase').runCompliancePhase,
        enrichComplianceFacts: () => {
            // playbooks/ may not require compliance/ (layering.test.js); the
            // AI Act detector is glued in here, where a route may require both.
            const facts = require('../../playbooks/phases/complianceFacts');
            const deps = facts.defaultDeps({ signalsFromDefinition: (...a) => require('../../compliance/aiAct/signals').signalsFromDefinition(...a) });
            return (args) => facts.enrich(args, deps);
        },
        guiDefaults: () => require('../../i18n/defaults/en').GUI_DEFAULTS,
        gatherFacts: () => require('../../playbooks/phases/compliancePhase').gatherFacts,
        frameworkPolicy: () => require('../../compliance/frameworkPolicy'),
        riskStore: () => require('../../stores/riskStore'),
        complianceStore: () => require('../../stores/complianceStore'),
        complianceFrameworks: () => require('../../compliance/frameworks'),
        studioAppDataStore: () => require('../../stores/studioAppDataStore'),
        now: () => Date.now,
    });
}

module.exports = { makeDefaultDeps };
