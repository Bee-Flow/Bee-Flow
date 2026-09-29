/**
 * The Studio tables that hold personal data, as processing activities.
 *
 * The register was built from published agents, the integration log and a few
 * static rows — datatables and the apps on top of them appeared NOWHERE, even
 * though that is where a workspace's own personal data actually lands. The
 * material was already on the row (`lawful_basis`, `retention_days`,
 * `retention_field`, `subject_column`) and only the DSR discovery and the
 * retention sweep ever read it.
 *
 * A table is in the register when someone has RECORDED something about it — a
 * legal basis or a retention period. That is the opt-in: an untouched scratch
 * table is not a processing activity, and auto-listing every table would make
 * the register a list of tables instead of a record of processing.
 */

'use strict';

/** Fields whose name says what kind of personal data the table holds. */
const CATEGORY_HINTS = Object.freeze([
    { re: /\b(name|naam|voornaam|achternaam|surname|contact)\b/i, label: 'Names' },
    { re: /\b(e?mail|e-?mailadres)\b/i, label: 'E-mail addresses' },
    { re: /\b(phone|tel|telefoon|mobile|mobiel)\b/i, label: 'Phone numbers' },
    { re: /\b(address|adres|street|straat|postcode|zip|city|woonplaats)\b/i, label: 'Addresses' },
    { re: /\b(bsn|ssn|passport|paspoort|id_?number)\b/i, label: 'Identity numbers' },
    { re: /\b(iban|bank|rekening|account_?number)\b/i, label: 'Bank details' },
    { re: /\b(birth|geboorte|dob)\b/i, label: 'Dates of birth' },
    { re: /\b(health|gezondheid|medical|medisch)\b/i, label: 'Health data' },
]);

function categoriesOf(fields) {
    const out = [];
    for (const hint of CATEGORY_HINTS) {
        if ((fields || []).some((f) => hint.re.test(`${(f && f.key) || ''} ${(f && f.name) || ''}`))) out.push(hint.label);
    }
    return out;
}

function defaultDeps() {
    return {
        getAll: (...a) => require('../../db').getAll(...a),
        getTableMeta: (...a) => require('../../stores/datatableStore').getTableMeta(...a),
    };
}

/**
 * One activity per registered table of this organisation.
 *
 * Both scopes: a table in the organisation's own scope, and a personal table
 * of someone in it — the register asks what THIS organisation processes, and
 * a personal table full of customer e-mail addresses is not outside that
 * question because of where it is filed.
 */
async function datatableActivities(orgId, deps = defaultDeps()) {
    if (!orgId) return [];
    let rows = [];
    try {
        rows = await deps.getAll(`
            SELECT id, name, description, scope_kind, scope_id, organization_id,
                   lawful_basis, retention_days, retention_field, subject_column, row_scope,
                   is_published, shared_groups, row_count, created_at
              FROM datatables
             WHERE organization_id = $1
               AND (lawful_basis IS NOT NULL OR retention_days IS NOT NULL)
             ORDER BY created_at ASC
        `, [orgId]);
    } catch {
        return [];   // a register that cannot read is short, never wrong
    }
    const out = [];
    for (const r of (rows || [])) {
        let fields = [];
        try {
            const meta = await deps.getTableMeta({ kind: r.scope_kind, id: r.scope_id }, r.id);
            fields = (meta && meta.fields) || [];
        } catch { /* the row still describes a processing activity */ }
        const categories = categoriesOf(fields);
        const days = Number(r.retention_days);
        out.push({
            activity_id: `datatable:${r.id}`,
            name: r.name,
            purpose: r.description || 'Data kept in a Studio table and used by the apps and automations built on it.',
            data_categories: categories.length ? categories : ['Recorded in the table’s columns'],
            data_subjects: r.subject_column
                ? [`The people identified by "${r.subject_column}"`]
                : ['People whose data is entered into this table'],
            recipients: r.is_published
                ? ((Array.isArray(r.shared_groups) && r.shared_groups.length)
                    ? 'Members of the groups this table is shared with'
                    : 'Everyone in this organisation')
                : 'The owner, and whoever holds an explicit grant',
            transfers: [],
            // Only what is actually enforced. The retention job sweeps exactly
            // this column pair (jobs/datatableRetention.js), so when it is set
            // the sentence is a fact and not an intention.
            retention: Number.isFinite(days) && days > 0
                ? `${days} days, deleted automatically on "${r.retention_field || 'created_at'}".`
                : 'No retention recorded — nothing is deleted automatically.',
            security_measures: [
                'Row-level access by grade, and by role where the app sets one',
                'Encryption at rest and in transit',
                r.row_scope === 'own' ? 'Each person sees only the rows they created' : null,
            ].filter(Boolean),
            ai_act: null,
            legal_basis: r.lawful_basis || null,
            // The link the register never had: which object this row is about.
            source: { kind: 'datatable', id: r.id, scope: { kind: r.scope_kind, id: r.scope_id } },
            row_count: Number.isFinite(Number(r.row_count)) ? Number(r.row_count) : null,
        });
    }
    return out;
}

module.exports = { datatableActivities, categoriesOf, CATEGORY_HINTS };
