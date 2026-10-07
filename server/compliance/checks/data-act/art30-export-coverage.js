/**
 * Data Act Art. 23(c) / Art. 25(2)(a),(e) / Art. 30(5) — all exportable data
 * can be ported. (Art. 30(1) is functional equivalence for IaaS providers and
 * is not what this check measures; the id and `article: '30'` stay for the
 * evidence history, and Art. 30(5) itself requires the export of all
 * exportable data.)
 *
 * A customer switching away from the service must be able to take ALL its data
 * along. The export registry (dataPortability/exportRegistry.js) lists every
 * kind of data the platform holds for an organisation with the export route
 * that serves it — including the kinds that have NO route today. This check
 * reads the org's held counts and asks, for every kind actually held:
 *
 *   route declared AND mounted on the running router → covered
 *   any held kind uncovered                         → fail  (names them)
 *   a kind WITHOUT a usable route whose count failed → warn  (names them: the
 *                                                            count could not be
 *                                                            taken, so "nothing
 *                                                            held" is unproven)
 *   all covered, but a per-item-only route serves a kind with > 50 items
 *                                                   → warn  (a customer would
 *                                                            click 51+ times)
 *   otherwise                                       → pass
 *
 * The check never performs an export. It fails honestly while the known
 * product gaps (agents, knowledge bases in bulk, conversations, AI webpages as
 * an archive, form submissions) exist — that is the point; the gaps are listed
 * as product work in the evidence. Also counts for DORA Art. 28(8) (exit
 * strategies) and GDPR Art. 20 (portability).
 *
 * Evidence is the matrix: kind, held count, route, formats, mounted, scope.
 * Counts are counts — no row content, no ids of exported items.
 */

const complianceStore = require('../../../stores/complianceStore');
const exportRegistry = require('../../dataPortability/exportRegistry');

const PER_ITEM_BULK_THRESHOLD = 50;

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return rel && typeof rel === 'object' ? rel : {};
}

module.exports = {
    id: 'DATA_ACT-Art30-export-coverage',
    regulation: 'DATA_ACT',
    article: '30',
    frameworks: [
        { regulation: 'DORA', ref: 'Art. 28(8)' },
        { regulation: 'GDPR', ref: 'Art. 20' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_data_act_export_coverage_title',
    descriptionKey: 'compliance.check_data_act_export_coverage_desc',
    remediationKey: 'compliance.check_data_act_export_coverage_fix',
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
        const unknown = matrix.filter(k => k.held === null).map(k => k.kind);
        // A kind whose count failed (held === null) is NOT a kind that holds
        // nothing: the query could not look. That is harmless while the kind
        // has a mounted export route — whatever it holds can be taken along —
        // but a kind with no route, or an unmounted one, may hold data that
        // cannot be exported and nobody can tell. Those can never produce a
        // pass; they are named in the verdict.
        const unknownUncoverable = matrix.filter(k => k.held === null && (!k.route || !k.mounted)).map(k => k.kind);

        const evidence = {
            kinds_total: matrix.length,
            kinds_held: held.length,
            kinds_unknown: unknown,
            kinds_unknown_uncoverable: unknownUncoverable,
            matrix: matrix.map(k => ({
                kind: k.kind,
                held: k.held,
                route: k.route ? `${k.route.method} ${k.route.path}` : null,
                formats: k.formats,
                mounted: k.mounted,
                scope: k.scope,
                render_only: k.render_only ? `${k.render_only.method} ${k.render_only.path}` : null,
                product_gap: !k.route,
            })),
        };

        if (held.length === 0) {
            if (unknown.length === matrix.length) {
                return {
                    status: 'warn',
                    evidence: { ...evidence, reason: 'held counts unavailable' },
                    details: 'not provisioned yet — none of the data tables could be counted, so export coverage cannot be established.',
                };
            }
            if (unknownUncoverable.length > 0) {
                return {
                    status: 'warn',
                    evidence,
                    details: `No data kind could be counted as held, but ${unknownUncoverable.length} kind(s) with no usable export route could not be counted either (${unknownUncoverable.join(', ')}) — "not counted" is not "nothing to export", so coverage cannot be established for those.`,
                };
            }
            return {
                status: 'not_applicable',
                evidence,
                details: 'This organisation holds no exportable data yet — nothing to take along when switching.',
            };
        }

        const uncovered = held.filter(k => !k.route || !k.mounted);
        const productGaps = uncovered.filter(k => !k.route).map(k => k.kind);
        const unmounted = uncovered.filter(k => k.route && !k.mounted).map(k => k.kind);
        evidence.uncovered = uncovered.map(k => k.kind);
        evidence.product_gaps = productGaps;
        evidence.unmounted_routes = unmounted;

        if (uncovered.length > 0) {
            const parts = [];
            if (productGaps.length) parts.push(`no export endpoint exists for ${productGaps.join(', ')} (product gap)`);
            if (unmounted.length) parts.push(`the declared export route is not mounted for ${unmounted.join(', ')}`);
            return {
                status: 'fail',
                evidence,
                details: `${uncovered.length} of ${held.length} held data kind(s) cannot be exported: ${parts.join('; ')}. Art. 23(c) and Art. 25(2)(a),(e) require all exportable data to be portable when switching — see the Portability matrix.`,
            };
        }

        const perItemHeavy = held.filter(k => k.scope === 'per-item' && k.held > PER_ITEM_BULK_THRESHOLD).map(k => `${k.kind} (${k.held})`);
        evidence.per_item_heavy = perItemHeavy;

        if (unknownUncoverable.length > 0) {
            const heavy = perItemHeavy.length
                ? ` (${perItemHeavy.join(', ')} can also only be exported one item at a time.)`
                : '';
            return {
                status: 'warn',
                evidence,
                details: `Every counted data kind has a mounted export route, but ${unknownUncoverable.length} kind(s) without one could not be counted (${unknownUncoverable.join(', ')}). Whether this organisation holds data that cannot be exported is unknown — export coverage (Art. 23(c), 25(2)(e)) is not established until those kinds can be counted.${heavy}`,
            };
        }

        if (perItemHeavy.length > 0) {
            return {
                status: 'warn',
                evidence,
                details: `All ${held.length} held data kind(s) have an export route, but ${perItemHeavy.join(', ')} can only be exported one item at a time — more than ${PER_ITEM_BULK_THRESHOLD} items makes switching impractical without a bulk export.`,
            };
        }

        return {
            status: 'pass',
            evidence,
            details: `All ${held.length} held data kind(s) have a mounted export route.` + (unknown.length ? ` ${unknown.length} kind(s) could not be counted on this install (${unknown.join(', ')}).` : ''),
        };
    },
};

module.exports._test = { PER_ITEM_BULK_THRESHOLD };
