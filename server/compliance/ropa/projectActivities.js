// @typecheck
'use strict';

/**
 * Collaborative projects as processing activities.
 *
 * A project whose members keep client files, notes and conversations in it is
 * a processing activity like any other — but the register only knew agents,
 * integrations and Studio tables. A project enters the register the way a
 * table does: when an admin RECORDED something about it (a lawful basis or a
 * retention period) in its processing record, compliance_subject_registrations
 * (kept through routes/compliance/projectRegistrations.js, and asked for by
 * GDPR-Art30-project-personal-data when signals show personal data).
 *
 * The categories come from the persisted personal-data signals (never from
 * reading content). The register is a live admin document, so the project's
 * current NAME is used here — unlike the evidence chain, which only ever holds
 * ids.
 */

const pd = require('../projects/projectData');

const KIND_LABEL = Object.freeze({
    name: 'Names',
    email: 'E-mail addresses',
    phone: 'Phone numbers',
    address: 'Addresses',
    id_number: 'Identity numbers',
    financial: 'Bank and payment details',
    birth: 'Dates of birth',
    health: 'Health data',
    online_id: 'Online identifiers',
    supplier: 'Supplier contacts',
    personal: 'Personal data (kind not determined)',
});

function defaultDeps() {
    return {
        query: pd.defaultQuery(),
        complianceStore: require('../../stores/complianceStore'),
        signals: require('../projects/personalDataSignals').sharedReader(),
    };
}

function kindLabels(kinds) {
    return (kinds || []).map(k => KIND_LABEL[k] || k);
}

/** One activity per registered project of this organisation. */
async function projectActivities(orgId, deps = defaultDeps()) {
    if (!orgId) return [];
    let registrations = [];
    try {
        registrations = (await deps.complianceStore.listSubjectRegistrations(orgId, 'project'))
            .filter(r => r.lawful_basis || Number(r.retention_days) > 0);
    } catch {
        return [];   // a register that cannot read is short, never wrong
    }
    if (!registrations.length) return [];
    const ids = registrations.map(r => String(r.subject_id));
    let names = new Map();
    // Whether the lookup ANSWERED. Once it did, a registration it did not
    // return belongs to a project that is gone (or is not this org's) — even
    // when that is every one of them, which an empty map alone cannot tell
    // apart from a lookup that failed.
    let namesRead = false;
    try {
        const rows = await deps.query(`
            SELECT p.id, p.name FROM projects p
            WHERE ${pd.orgMatch('p.organization_id')} AND p.id = ANY($2::text[])
        `, [orgId, ids]);
        names = new Map((rows || []).map(r => [String(r.id), r.name]));
        namesRead = true;
    } catch { /* ids stand in for names */ }
    let byProject = new Map();
    try { byProject = (await deps.signals.signalsFor(orgId)).byProject; } catch { /* categories unknown */ }
    const out = [];
    for (const r of registrations) {
        const id = String(r.subject_id);
        if (namesRead && !names.has(id)) continue; // the project is gone (or not this org's)
        const kinds = byProject.get(id)?.kinds || [];
        const days = Number(r.retention_days);
        out.push({
            activity_id: `project:${id}`,
            name: names.get(id) || pd.shortRef(id),
            purpose: r.purpose || 'Collaboration in a project workspace: chats, documents, notebooks and files shared by its members.',
            data_categories: kinds.length ? kindLabels(kinds) : ['Whatever members keep in the project'],
            data_subjects: ['People named in the project’s chats, documents, notebooks and files', 'The project’s members'],
            recipients: 'The project’s members (owner, editors, viewers)',
            transfers: [],
            retention: Number.isFinite(days) && days > 0
                ? `${days} days of inactivity, checked by GDPR-Art5-1-e-project-retention.`
                : 'No retention recorded for this project.',
            security_measures: [
                'Access by project membership (owner, editor, viewer)',
                'Team chats encrypted with the project key',
                'Privacy Shield on every AI call made in the project',
            ],
            ai_act: null,
            legal_basis: r.lawful_basis || null,
            source: { kind: 'project', id },
            confirmed_at: r.confirmed_at || null,
        });
    }
    return out;
}

module.exports = { projectActivities, kindLabels, KIND_LABEL };
