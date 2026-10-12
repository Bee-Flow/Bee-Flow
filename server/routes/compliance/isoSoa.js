/**
 * Compliance — the ISO 27001 Statement of Applicability rows (list, seed,
 * per-control decision) and the two honest readiness numbers.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `SoaPatch` is `.strict()`, and on the row editor that matters twice over.
 * soaStore.upsertEntry answers a value it does not know by keeping the one
 * already on the row: `status:'aproved'` saved the row as 'todo' AND skipped
 * this route's `body.status === 'approved'` evidence write, so an approval an
 * auditor would sample never happened — under a 200 carrying the saved row.
 * `applicable:'false'` (the string) is not a boolean, so the control stayed
 * APPLICABLE while the screen said excluded.
 *
 * The schema is also the allow-list the store used to need: a key outside it
 * is now a 400 naming the key, instead of a column the editor does not own
 * being quietly dropped.
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const soaStore = require('../../stores/soaStore');
const ismsDocStore = require('../../stores/ismsDocStore');
const isoControls = require('../../compliance/iso/controls');
const { readinessCounts } = require('../../compliance/iso/readiness');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId, _isoChecksByControl, _recordSoaEvidence, _buildClauseConformity } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const SOURCES = ['auto', 'connector', 'attest', 'inherited'];
const DECISIONS = ['todo', 'reviewed', 'approved'];
const oneOf = (name, values) => z.enum(values, {
    errorMap: () => ({ message: `${name} is one of: ${values.join(', ')}.` }),
});

const PROVIDER_TEXT = 'provider must be the name of your IaaS provider.';
const SeedBody = bodyOf({
    provider: worded(PROVIDER_TEXT).trim().max(120, 'provider is at most 120 characters.').optional(),
});

/**
 * The keys the SoA row editor may write. `how_met` is the auditor-facing
 * "how is this control actually implemented" sentence (soaStore caps it at
 * 4000 chars). This object IS the allow-list — `.strict()` refuses anything
 * outside it, so a wider body can never reach a column the editor does not
 * own, and a misspelled key is answered instead of dropped.
 */
const SoaPatch = bodyOf({
    // Excluding a control is the SoA's central decision, so it is a boolean
    // and nothing else: the string 'false' used to leave it applicable.
    applicable: z.boolean({ invalid_type_error: 'applicable is true or false.' }).optional(),
    justification: worded('justification must be text.').trim().max(4000, 'justification is at most 4000 characters.').nullish(),
    how_met: worded('how_met must be text.').trim().max(4000, 'how_met is at most 4000 characters.').nullish(),
    source: oneOf('source', SOURCES).optional(),
    // 'approved' is what writes the evidence row an auditor samples.
    status: oneOf('status', DECISIONS).optional(),
    owner_user_id: worded('owner_user_id must be a user id.').trim().max(120, 'owner_user_id is at most 120 characters.').nullish(),
    evidence_ref: worded('evidence_ref must be text.').trim().max(500, 'evidence_ref is at most 500 characters.').nullish(),
});

const HISTORY_LIMIT_TEXT = 'limit must be a whole number of rows.';
const HistoryQuery = z.object({
    limit: z.coerce.number({ invalid_type_error: HISTORY_LIMIT_TEXT })
        .int(HISTORY_LIMIT_TEXT).min(1, HISTORY_LIMIT_TEXT).optional(),
}).strict();

// ───────────────── ISO 27001 — Statement of Applicability ─────────────────
//
// The SoA lives as ROWS with an audit trail — auditors sample the decision
// trail, never a generated document; the PDF export is only a render of these
// rows. Controls join to automated checks via the `controls` array each
// ISO27001 check module declares.

const SOA_SOURCE_FOR_BUCKET = { auto: 'auto', connector: 'connector', attest: 'attest', physical: 'inherited' };

router.get('/iso/soa', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const [entries, stats] = await Promise.all([
        soaStore.listEntries(orgId),
        soaStore.getStats(orgId),
    ]);
    const byRef = new Map(entries.map(e => [e.control_ref, e]));
    const checksByControl = _isoChecksByControl();
    res.json({
        controls: isoControls.CONTROLS.map(c => ({
            ref: c.ref,
            key: c.key,
            theme: c.theme,
            bucket: c.bucket,
            titleKey: c.titleKey,
            objectiveKey: c.objectiveKey,
            checks: checksByControl[c.ref] || [],
            entry: byRef.get(c.ref) || null,
        })),
        stats,
        themes: isoControls.THEMES,
    });
});

// Seed missing rows from the catalog buckets. Never overwrites an existing
// decision (INSERT … DO NOTHING in the store). Physical controls get the
// inherited-from-IaaS justification template pre-filled — still editable, and
// excluding a control remains an explicit human decision on the row.
router.post('/iso/soa/seed', requireAuth, requirePermission('admin_compliance'), validate({ body: SeedBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const provider = String(req.body?.provider || 'our IaaS provider').slice(0, 120);
    const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
    const seeds = isoControls.CONTROLS.map(c => ({
        control_ref: c.ref,
        applicable: true,
        source: SOA_SOURCE_FOR_BUCKET[c.bucket] || 'attest',
        justification: c.bucket === 'physical' && c.inheritedJustificationKey
            ? String(GUI_DEFAULTS[c.inheritedJustificationKey] || '').replace('{provider}', provider) || null
            : null,
    }));
    const inserted = await soaStore.seedMissing(orgId, seeds, actorId);
    if (inserted > 0) {
        await _recordSoaEvidence(orgId, 'seed', {
            action: 'soa_seeded', inserted, provider,
            by: actorId, at: new Date().toISOString(),
        });
    }
    res.json({ inserted, total: isoControls.CONTROLS.length });
});

router.put('/iso/soa/:ref', requireAuth, requirePermission('admin_compliance'), validate({ body: SoaPatch }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const ref = String(req.params.ref);
    if (!isoControls.byRef(ref)) return res.status(404).json({ error: `Unknown control ${ref}` });
    // SoaPatch is the allow-list; the schema has already refused everything
    // outside it, so the body goes to the store as it stands.
    const patch = req.body;
    const saved = await soaStore.upsertEntry(orgId, ref, patch, actorId);
    // Approval is the auditor-relevant transition — capture it in the chain.
    if (patch.status === 'approved') {
        await _recordSoaEvidence(orgId, ref, {
            action: 'soa_row_approved', control_ref: ref,
            applicable: saved.applicable, source: saved.source,
            justification: saved.justification,
            how_met: saved.how_met || null,
            by: actorId, at: new Date().toISOString(),
        });
    }
    res.json(saved);
});

/**
 * GET /iso/soa/history?limit= → { rows: [{ ref, action, status, by, at,
 * applicable, source, seq, hash }] } — the SoA decision trail, newest first.
 *
 * The trail is the evidence chain filtered to `subject_type = 'soa'`: the
 * per-row approvals (subject_id = the control ref) and the seed events
 * (subject_id = 'seed'). Auditors sample this, so the rows are read back from
 * the chain rather than re-derived from the current SoA state.
 *
 * Declared BEFORE `/iso/soa/:ref` would matter for a GET — there is no GET
 * on that path, but the literal segment stays first for safety.
 */
const SOA_HISTORY_MAX = 500;

router.get('/iso/soa/history', requireAuth, requirePermission('admin_compliance'), validate({ query: HistoryQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    // Clamped rather than refused: asking for more rows than the trail shows
    // is not a mistake worth a 400. A limit that is not a number is.
    const limit = req.query.limit === undefined ? 100 : Math.min(req.query.limit, SOA_HISTORY_MAX);
    const rows = await complianceStore.listEvidence(orgId, { subjectType: 'soa', limit });
    res.set('Cache-Control', 'private, no-store');
    res.json({
        rows: (rows || []).map(r => {
            const p = (r.payload && typeof r.payload === 'object') ? r.payload : {};
            return {
                ref: r.subject_id || null,
                action: p.action || null,
                status: p.action === 'soa_row_approved' ? 'approved' : (p.status || null),
                applicable: typeof p.applicable === 'boolean' ? p.applicable : null,
                source: p.source || null,
                inserted: typeof p.inserted === 'number' ? p.inserted : null,
                by: p.by || null,
                at: p.at || r.captured_at || null,
                seq: r.seq ?? null,
                hash: r.hash || null,
            };
        }),
    });
});

// Readiness — the two honest numbers plus context. Never a single blended
// "% ISO compliant": auditors attack that instantly. Number one is control
// verification (automated + connector buckets only), number two is SoA
// decision progress across all 93 rows.
router.get('/iso/readiness', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const [latest, soaStats, history, docs] = await Promise.all([
        complianceStore.getLatestPerCheck(orgId),
        soaStore.getStats(orgId).catch(() => null),
        complianceStore.getScoreHistory(orgId, 365).catch(() => []),
        ismsDocStore.listDocs(orgId).catch(() => []),
    ]);
    const statusByCheck = {};
    for (const r of latest) {
        const rank = { fail: 3, warn: 2, pass: 1, not_applicable: 0 };
        if (!statusByCheck[r.check_id] || (rank[r.status] || 0) > (rank[statusByCheck[r.check_id]] || 0)) {
            statusByCheck[r.check_id] = r.status;
        }
    }
    const checksByControl = _isoChecksByControl();
    const verifiable = isoControls.CONTROLS.filter(c => c.bucket === 'auto' || c.bucket === 'connector');
    // not_applicable is no verdict (an unconnected connector control answers
    // it), and warn-only controls count neither verified nor failing.
    const { verified, failing, unchecked } = readinessCounts(verifiable, checksByControl, statusByCheck);
    const published = docs.filter(d => d.status === 'published');
    const clauses = await _buildClauseConformity(orgId);
    res.json({
        controls: {
            verifiable_total: verifiable.length,
            verified, failing, unchecked,
            catalog_total: isoControls.CONTROLS.length,
        },
        soa: soaStats,
        operating_since: history.length ? history[0].captured_at : null,
        history_points: history
            .filter(h => h.iso_score !== null && h.iso_score !== undefined)
            .map(h => ({ captured_at: h.captured_at, score: h.iso_score })),
        policies: {
            published: published.length,
            total: docs.length,
            acknowledgements: published.reduce((s, d) => s + (d.ack_count || 0), 0),
        },
        clauses: clauses.map(c => ({ clause: c.clause, title: c.title, status: c.status })),
    });
});

module.exports = router;
