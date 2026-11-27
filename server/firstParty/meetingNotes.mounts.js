// @typecheck strict
'use strict';
/**
 * The mounts of module "meetingNotes": its rows of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order: the
 * core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */
/** @typedef {import('../modules/firstParty/contract').Gates} Gates */

/**
 * Nextcloud Talk / Google Meet / Teams → Meeting Notes settings: licence AND
 * the meeting_notes capability. Meeting Notes can be rolled out per group
 * (groupScoped), and a person outside that rollout must not reach its
 * settings, templates or connectors either. The org-level endpoints are
 * administration: an org admin outside the rollout still configures it for the
 * people inside it (auth/capabilityOrOrgAdmin.js), the personal ones are not.
 * @param {Gates} g
 * @param {'settingsOrgIdFor' | 'summaryTemplateOrgIdFor' | 'teamsSetupOrgIdFor'} orgIdForName which org an endpoint administers
 */
function meetingNotesGate(g, orgIdForName) {
    const { requireCapabilityOrOrgAdmin, [orgIdForName]: orgIdFor } = require('../auth/capabilityOrOrgAdmin');
    const capabilityGate = /** @type {import('express').RequestHandler & Record<symbol, Record<string, unknown> | undefined>} */ (g.requireCapability('meeting_notes'));
    return requireCapabilityOrOrgAdmin(capabilityGate, {
        orgIdFor, isOrgAdminForOrg: require('../auth/permissions').isOrgAdminForOrg, log: require('../telemetry/log'),
    });
}

/** @type {MountRow[]} */
const mounts = [
    // Meeting Notes — compound beta (license 'meeting_notes' AND the beta).
    { key: 'meetingNotes:/api/transcriptions', slot: 'main', path: '/api/transcriptions', handlers: (g) => [g.requireModule('meetingNotes'), g.requireCapability('meeting_notes'), g.requireTraining('meeting_notes'), require('../routes/transcriptions')] },
    // Nextcloud Talk → Meeting Notes settings (org + user toggles). Licence AND
    // the meeting_notes capability, or an org admin for the org-level endpoints (meetingNotesGate).
    { key: 'meetingNotes:/api/talk-notes-settings', slot: 'main', path: '/api/talk-notes-settings', handlers: (g) => [g.requireModule('meetingNotes'), g.requireLicenseFeature('meeting_notes'), meetingNotesGate(g, 'settingsOrgIdFor'), require('../routes/talkNotesSettings')] },
    // Google Meet → Meeting Notes settings (org + user toggles). Same gates as
    // talk-notes-settings above.
    { key: 'meetingNotes:/api/gmeet-notes-settings', slot: 'main', path: '/api/gmeet-notes-settings', handlers: (g) => [g.requireModule('meetingNotes'), g.requireLicenseFeature('meeting_notes'), meetingNotesGate(g, 'settingsOrgIdFor'), require('../routes/gmeetNotesSettings')] },
    // Microsoft Teams → Meeting Notes settings. Same gates.
    { key: 'meetingNotes:/api/teams-notes-settings', slot: 'main', path: '/api/teams-notes-settings', handlers: (g) => [g.requireModule('meetingNotes'), g.requireLicenseFeature('meeting_notes'), meetingNotesGate(g, 'settingsOrgIdFor'), require('../routes/teamsNotesSettings')] },
    // Teams setup and diagnostics. Same gates; every path is administration, so an org admin passes without the capability.
    { key: 'meetingNotes:/api/teams-setup', slot: 'main', path: '/api/teams-setup', handlers: (g) => [g.requireModule('meetingNotes'), g.requireLicenseFeature('meeting_notes'), meetingNotesGate(g, 'teamsSetupOrgIdFor'), require('../routes/teamsSetup.mts').teamsSetupRouter] },
    // Custom summary-regeneration templates (user / org / group scopes).
    { key: 'meetingNotes:/api/summary-templates', slot: 'main', path: '/api/summary-templates', handlers: (g) => [g.requireModule('meetingNotes'), g.requireLicenseFeature('meeting_notes'), meetingNotesGate(g, 'summaryTemplateOrgIdFor'), require('../routes/summaryTemplates')] },
    // Per-person voiceprints for pyannoteAI speaker identification. Same compound
    // gate as /api/transcriptions — the templates only have value there, and the
    // router additionally refuses everything unless pyannoteAI is the active
    // transcription provider.
    { key: 'meetingNotes:/api/voiceprints', slot: 'main', path: '/api/voiceprints', handlers: (g) => [g.requireModule('meetingNotes'), g.requireCapability('meeting_notes'), require('../routes/voiceprints')] },
];

module.exports = { mounts };
