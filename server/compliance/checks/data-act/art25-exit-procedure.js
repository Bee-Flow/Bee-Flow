/**
 * Data Act Art. 25(2)(a),(b),(e) / Art. 23(a),(c) — an exit procedure exists and has
 * been exercised. Also DORA Art. 28(8): exit strategies for ICT services.
 *
 * Paper and practice:
 *   PAPER    — the ISMS document `exit-procedure` (13th policy seed) is
 *              published. Not published → fail: without a written procedure
 *              switching is improvised.
 *   PRACTICE — either an export actually happened in the last year (the
 *              export routes stamp `data_export_performed` evidence rows via
 *              dataPortability/stampExport.js — only PORTABLE kinds count, a
 *              PDF render is not an exit), or an admin attested a full export
 *              test (`exit_procedure_tested_at`) within the last year.
 *
 *   doc published + export or test ≤ 365 d → pass
 *   doc published, test older than 365 d   → warn (stale)
 *   doc published, nothing exercised       → warn
 *   doc not published                      → fail
 *
 * Hybrid: the document and the export stamps are automated, the test date is
 * an attestation. Evidence: document version + sha256, export counts per kind
 * and the last export timestamp, the attested test date. Never the document
 * body, never who exported or who attested.
 */

const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const ismsDocStore = require('../../../stores/ismsDocStore');
const exportRegistry = require('../../dataPortability/exportRegistry');

const DOC_SLUG = 'exit-procedure';
const WINDOW_DAYS = 365;
const DAY_MS = 86400e3;
const NOT_PROVISIONED = new Set(['42P01', '42703']);
const STAMP_ACTION = 'data_export_performed';

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return rel && typeof rel === 'object' ? rel : {};
}

function _ts(value) {
    if (!value) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

/** Export stamps in the window, grouped by kind. `null` when the evidence table is not provisioned. */
async function _exportStamps(orgId, checkId) {
    try {
        return await getAll(`
            SELECT payload->>'kind' AS kind,
                   COUNT(*)::int    AS exports,
                   MAX(captured_at) AS last_at
            FROM compliance_evidence
            WHERE organization_id = $1
              AND check_id = $2
              AND subject_type = 'export'
              AND payload->>'action' = $3
              AND captured_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'
            GROUP BY payload->>'kind'
        `, [orgId, checkId, STAMP_ACTION]);
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) return null;
        throw e;
    }
}

module.exports = {
    id: 'DATA_ACT-Art25-exit-procedure',
    regulation: 'DATA_ACT',
    article: '25(2)(a)',
    frameworks: [
        { regulation: 'DORA', ref: 'Art. 28(8)' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.check_data_act_exit_procedure_title',
    descriptionKey: 'compliance.check_data_act_exit_procedure_desc',
    remediationKey: 'compliance.check_data_act_exit_procedure_fix',
    remediationLink: 'admin/compliance/policies',

    async evaluate(orgId) {
        const settings = (await complianceStore.getSettings(orgId)) || {};
        if (_relevance(settings).data_act === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The Data Act was marked not relevant for this organisation.',
            };
        }

        // PAPER
        let doc = null;
        try {
            doc = await ismsDocStore.getPublishedBody(orgId, DOC_SLUG);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { document_slug: DOC_SLUG, documents_provisioned: false },
                    details: 'not provisioned yet — the ISMS document tables are missing, so the exit procedure cannot be read.',
                };
            }
            throw e;
        }
        const document = doc ? {
            slug: DOC_SLUG,
            version: doc.version ?? null,
            sha256: doc.sha256 ?? null,
            published_at: doc.published_at ?? null,
        } : { slug: DOC_SLUG, published: false };

        if (!doc) {
            return {
                status: 'fail',
                evidence: { document, window_days: WINDOW_DAYS },
                details: 'No published exit-procedure document. Without a written procedure for handing all data over and closing the account, switching (Art. 25) and exit (DORA Art. 28(8)) are improvised — publish the "Exit procedure" policy under Compliance → Policies.',
            };
        }

        // PRACTICE — real exports
        const stamps = await _exportStamps(orgId, module.exports.id);
        if (stamps === null) {
            return {
                status: 'warn',
                evidence: { document, window_days: WINDOW_DAYS, exports_provisioned: false },
                details: 'not provisioned yet — the evidence table has no export stamps yet, so it cannot be shown that the exit procedure was exercised.',
            };
        }
        const portable = new Set(exportRegistry.portableKinds());
        const byKind = {};
        let lastExportAt = null;
        let portableExports = 0;
        let renderOnlyExports = 0;
        for (const s of stamps) {
            const kind = s.kind || 'unknown';
            const n = Number(s.exports) || 0;
            byKind[kind] = n;
            if (portable.has(kind)) {
                portableExports += n;
                const t = _ts(s.last_at);
                if (t !== null && (lastExportAt === null || t > lastExportAt)) lastExportAt = t;
            } else {
                renderOnlyExports += n;
            }
        }

        // PRACTICE — attested test
        const now = Date.now();
        const testedAt = _ts(settings.exit_procedure_tested_at);
        const testAgeDays = testedAt === null ? null : Math.floor((now - testedAt) / DAY_MS);
        const testFresh = testAgeDays !== null && testAgeDays <= WINDOW_DAYS;

        const evidence = {
            document,
            window_days: WINDOW_DAYS,
            exports_provisioned: true,
            portable_exports: portableExports,
            render_only_exports: renderOnlyExports,
            exports_by_kind: byKind,
            last_export_at: lastExportAt === null ? null : new Date(lastExportAt).toISOString(),
            tested_at: testedAt === null ? null : new Date(testedAt).toISOString(),
            test_age_days: testAgeDays,
            tested_by_recorded: typeof settings.exit_procedure_tested_by === 'string' && settings.exit_procedure_tested_by.length > 0,
        };

        if (portableExports > 0 || testFresh) {
            const how = [];
            if (portableExports > 0) how.push(`${portableExports} real export(s) in the last ${WINDOW_DAYS} days (last ${evidence.last_export_at.slice(0, 10)})`);
            if (testFresh) how.push(`a full export test attested ${testAgeDays} day(s) ago`);
            return {
                status: 'pass',
                evidence,
                details: `Exit procedure v${document.version} is published and exercised: ${how.join(' and ')}.`,
            };
        }
        if (testedAt !== null) {
            return {
                status: 'warn',
                evidence,
                details: `Exit procedure v${document.version} is published, but the last attested export test is ${testAgeDays} days old and no real export happened in the last ${WINDOW_DAYS} days. Perform (or attest) a full export at least yearly.`,
            };
        }
        return {
            status: 'warn',
            evidence,
            details: `Exit procedure v${document.version} is published but never exercised: no export in the last ${WINDOW_DAYS} days and no attested export test.`
                + (renderOnlyExports ? ` (${renderOnlyExports} PDF render(s) do not count — a render is not a portable export.)` : ''),
        };
    },
};

module.exports._test = { DOC_SLUG, WINDOW_DAYS, STAMP_ACTION };
