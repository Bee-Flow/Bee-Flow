/**
 * Data Act Art. 30(1)(3) — exports come in a structured, commonly used,
 * machine-readable format.
 *
 * Portability is only real when the receiving service can read what was
 * exported: JSON, NDJSON, CSV, XLSX, XML, an archive of those, Markdown or
 * DOCX migrate; a PDF or a rendered HTML page does not. Over the same export
 * registry as the coverage check, for every kind that is HELD and COVERED
 * (route declared and mounted):
 *
 *   at least one machine-readable format → fine
 *   only pdf/html/txt                     → flagged
 *
 *   any flagged kind → warn (names them); all fine → pass;
 *   no covered kind held → not_applicable (coverage is the other check's job).
 *
 * Kinds held with only a render route (AI webpages → PDF) are listed in the
 * evidence as `render_only` so the reader sees "pdf-only" rather than
 * "nothing", but they are the coverage check's finding, not this one's.
 * Also counts for GDPR Art. 20.
 */

const complianceStore = require('../../../stores/complianceStore');
const exportRegistry = require('../../dataPortability/exportRegistry');

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return rel && typeof rel === 'object' ? rel : {};
}

function _machineReadable(formats) {
    return (formats || []).filter(f => exportRegistry.MACHINE_READABLE_FORMATS.includes(f));
}

module.exports = {
    id: 'DATA_ACT-Art30-machine-readable-formats',
    regulation: 'DATA_ACT',
    article: '30(3)',
    frameworks: [
        { regulation: 'GDPR', ref: 'Art. 20' },
    ],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_data_act_formats_title',
    descriptionKey: 'compliance.check_data_act_formats_desc',
    remediationKey: 'compliance.check_data_act_formats_fix',
    remediationLink: 'admin/compliance/portability',

    async evaluate(orgId) {
        const settings = (await complianceStore.getSettings(orgId)) || {};
        if (_relevance(settings).data_act === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The Data Act was marked not relevant for this organisation.',
            };
        }

        const matrix = await exportRegistry.coverageMatrix(orgId);
        const held = matrix.filter(k => typeof k.held === 'number' && k.held > 0);
        const covered = held.filter(k => k.route && k.mounted);
        const renderOnly = held.filter(k => !k.route && k.render_only).map(k => ({
            kind: k.kind, held: k.held, formats: k.render_only.formats || [],
        }));

        const perKind = covered.map(k => {
            const mr = _machineReadable(k.formats);
            return { kind: k.kind, held: k.held, formats: k.formats, machine_readable: mr, ok: mr.length > 0 };
        });
        const flagged = perKind.filter(k => !k.ok);

        const evidence = {
            machine_readable_formats: [...exportRegistry.MACHINE_READABLE_FORMATS],
            covered_kinds: perKind.length,
            kinds: perKind,
            flagged: flagged.map(k => k.kind),
            render_only: renderOnly,
        };

        if (perKind.length === 0) {
            return {
                status: 'not_applicable',
                evidence,
                details: held.length === 0
                    ? 'This organisation holds no exportable data yet — no export formats to assess.'
                    : 'None of the held data kinds has a working export route yet — see the export-coverage check; there is no format to assess.',
            };
        }

        if (flagged.length > 0) {
            const named = flagged.map(k => `${k.kind} (${k.formats.join('/') || 'no format declared'})`).join(', ');
            return {
                status: 'warn',
                evidence,
                details: `${flagged.length} of ${perKind.length} export route(s) only produce a rendered format: ${named}. A PDF or HTML render cannot be imported elsewhere — add a JSON, CSV, ZIP or DOCX variant.`,
            };
        }

        return {
            status: 'pass',
            evidence,
            details: `All ${perKind.length} export route(s) for held data offer a machine-readable format.`
                + (renderOnly.length ? ` ${renderOnly.map(r => r.kind).join(', ')} currently only render (${renderOnly.map(r => r.formats.join('/')).join(', ')}) — tracked by the export-coverage check.` : ''),
        };
    },
};
