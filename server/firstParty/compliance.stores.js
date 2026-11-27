// @typecheck strict
/**
 * The store schemas of the module "compliance" (part of
 * firstParty/compliance.js, see modules/firstParty/parts.js). The rows were the
 * module's entries of storeModules.js STORE_MODULES; their order stays the
 * core's (modules/firstParty/order.json), which keeps the chat signal stores of
 * the core between dpiaStore and dsrStore.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    // The Compliance Hub family: all already modern (memo + export), only never registered.
    { name: 'complianceStore', file: './stores/complianceStore' },
    { name: 'dpiaStore', file: './stores/dpiaStore' },
    { name: 'dsrStore', file: './stores/dsrStore' },
    { name: 'incidentStore', file: './stores/incidentStore' },
    { name: 'riskStore', file: './stores/riskStore' },
    { name: 'soaStore', file: './stores/soaStore' },
    { name: 'ismsDocStore', file: './stores/ismsDocStore' },
    { name: 'isoAuditStore', file: './stores/isoAuditStore' },
    { name: 'isoEvidenceStore', file: './stores/isoEvidenceStore' },
    { name: 'isoObligationStore', file: './stores/isoObligationStore' },
    // Compliance redesign (Sep 2026): AI Act assessments, custom frameworks and
    // their attestations, and the release log behind PLD-Art9.
    { name: 'aiActAssessmentStore', file: './stores/aiActAssessmentStore' },
    { name: 'customFrameworkStore', file: './stores/customFrameworkStore' },
];

module.exports = { stores };
