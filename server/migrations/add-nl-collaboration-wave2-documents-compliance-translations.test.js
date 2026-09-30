/**
 * The Dutch for the second collaboration round, part two (the documents
 * product and the compliance checks for collaborative projects). The rules
 * themselves live in testUtils/nlCatalogueChecks.js; this file says which
 * keys the catalogue answers for.
 *
 * Run: node --test migrations/add-nl-collaboration-wave2-documents-compliance-translations.test.js
 */

const { registerNlCatalogueChecks } = require('../testUtils/nlCatalogueChecks');
const catalogue = require('./add-nl-collaboration-wave2-documents-compliance-translations');

registerNlCatalogueChecks({
    name: 'add-nl-collaboration-wave2-documents-compliance-translations',
    catalogue,
    mayHold: ['documents.', 'compliance.'],
    // The families this round created from scratch. Older documents and
    // compliance keys (and the flat keys this round added next to them) have
    // other owners or no Dutch yet, so they are not claimed as a whole; the
    // portability rows (compliance.pf_*) are also held to the Compliance
    // Center catalogue's coverage test, which accepts this catalogue for them.
    mustCover: [
        'documents.conflict.', 'documents.deck.', 'documents.find.', 'documents.library.', 'documents.mode.',
        'documents.new.', 'documents.outline.', 'documents.page.', 'documents.person.', 'documents.presence.',
        'documents.project.', 'documents.recovery.', 'documents.save.', 'documents.shortcuts.', 'documents.status.',
        'documents.tools.', 'documents.workspace.',
        'compliance.checks.gdpr_project_', 'compliance.checks.iso_project_', 'compliance.checks.aia_project_',
        'compliance.settings.project_', 'compliance.finding_state.', 'compliance.project_hint.',
        'compliance.ropa_projects.', 'compliance.pd_kind.', 'compliance.dsr_discovery_project_',
    ],
    declaredFor: {
        'documents.library.team': 'Team',
        'documents.project.changed_by': '{time} · {name}',
        'documents.status.in_section': 'In: {section}',
        'documents.tools.parameters': 'Parameters',
        'documents.workspace.document': 'Document',
        'documents.workspace.label': 'Label',
        'documents.workspace.parameters': 'Parameters',
        'compliance.ropa_projects.col_project': 'Project',
    },
});
