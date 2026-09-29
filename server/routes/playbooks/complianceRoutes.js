/**
 * WHAT A PERSON DOES WITH THE COMPLIANCE REVIEW.
 *
 * Three POSTs on a compliance phase, in the order they were registered:
 * resolve-plan asks the model how ONE finding could be fixed (it writes
 * nothing), retention-preview says what a retention period would mean for
 * the rows that are really there (it writes nothing), and register is the
 * ONE write of the phase.
 *
 * The three doc comments below were stacked above resolve-plan in the file
 * this came from; each now sits on the route it describes.
 */

'use strict';

const lifecycle = require('../../playbooks/lifecycle');
const { z, sendErr, isObject, worded, bodyOf, check } = require('./contract');
const { directoryFor } = require('./directory');

// -- The envelope around the three POSTs ------------------------------
//
// `validateRegistration` below is already careful about what it reads, and it
// stays: the legal basis, the retention pair and the subject column are the
// things an auditor samples, and that function is where they are measured.
// What was missing is the envelope AROUND it -- a misspelled `registration`
// or `risks` was dropped, and the route answered `{ written: [], failed: [] }`
// with a 200. "Nothing to register" and "you named the field wrong" are not
// the same sentence, and only the first one is safe to draw as a tick.
const CODE_TEXT = 'code is the code of a finding on this review.';
const ResolvePlanBody = bodyOf({ code: worded(CODE_TEXT).trim().min(1, CODE_TEXT).max(200, CODE_TEXT) });

const FIELD_TEXT = 'retentionField is the column to count the retention from.';
const DAYS_TEXT = 'retentionDays is a number of days.';
/**
 * A number of days: a number, or the digits of one. It was `z.coerce.number`,
 * and coercion reads `true` as 1 and `[]`, `null` and `''` as 0 -- so a
 * boolean asked for "keep one day". The value itself is measured where it is
 * used (1..MAX_RETENTION_DAYS), in a sentence.
 */
const dayCount = () => z.union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/)], { errorMap: () => ({ message: DAYS_TEXT }) });
const RetentionPreviewBody = bodyOf({
    retentionField: worded(FIELD_TEXT).trim().min(1, FIELD_TEXT),
    retentionDays: dayCount(),
});

// `registration` keeps its own reader (validateRegistration), which measures
// the VALUES and reports a refused one in `failed` while the rest of the
// register still lands. What it could not see is a key it never reads:
// `{ lawfullBasis: 'contract' }` skipped the table without a word, the
// evidence chain recorded the misspelled registration as `registered`, and
// the answer was `failed: []`. So the document's KEYS are closed here, and its
// values stay loose enough for validateRegistration to answer in its own
// sentences -- except `retentionDays: true`, which it read as one day.
//
// `risks` is the list of finding CODES the person chose to keep, matched
// against this review's own findings below. A code that names no finding on
// this review is still ignored rather than refused, because the codes come off
// the screen the person is looking at and a stale screen is not a bad request.
const REG_TEXT = 'registration holds lawfulBasis, retentionDays, retentionField and subjectColumn, and nothing else.';
const Registration = z.object({
    lawfulBasis: worded('lawfulBasis is one of the six legal bases, as text.').nullish(),
    retentionDays: z.union([dayCount(), z.literal('')], { errorMap: () => ({ message: DAYS_TEXT }) }).nullish(),
    retentionField: worded(FIELD_TEXT).nullish(),
    subjectColumn: worded('subjectColumn is the column that names the person.').nullish(),
}, { invalid_type_error: 'registration is a document.' }).strict(REG_TEXT);
const RISKS_TEXT = 'risks is a list of finding codes.';
const RegisterBody = bodyOf({
    registration: Registration.nullish(),
    risks: z.array(worded(RISKS_TEXT), { invalid_type_error: RISKS_TEXT }).nullish(),
});
const { kindOf, firstOfKind, localeOf } = require('./phaseList');
const log = require('../../telemetry/log');

/**
 * The six legal bases Art. 6 gives, and the cap the datatables route applies.
 * Kept in step with `routes/datatables.js` on purpose: the register wrote
 * straight to `updateDatatableMeta` and so skipped every one of those rules —
 * a basis the Compliance Center does not recognise, a retention of up to a
 * hundred years, a retention field naming a column that does not exist, and
 * worst of all a retention period with NO field, which the clean-up job can
 * never act on. The phase claims the registration is real, so it has to be.
 */
const LAWFUL_BASES = Object.freeze(['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests']);
const MAX_RETENTION_DAYS = 3650;
// `created_at` and `updated_at` are TIMESTAMPTZ on EVERY datatable
// (dataModel/ddl.js) and the retention job ages rows by either, so they are
// always a valid answer and need no column to be declared. Refusing them was
// how a table with no date column of its own ended up unable to record a
// retention period at all — "when the row was added" was there the whole time
// (owner, 2026-09-17).
const RETENTION_SYSTEM_FIELDS = Object.freeze(['created_at', 'updated_at']);

function validateRegistration(reg, fields) {
    const keys = new Set([
        ...RETENTION_SYSTEM_FIELDS,
        ...(Array.isArray(fields) ? fields : []).map((f) => f && f.key).filter(Boolean),
    ]);
    const patch = {};
    if (typeof reg.lawfulBasis === 'string' && reg.lawfulBasis) {
        const basis = reg.lawfulBasis.trim();
        if (!LAWFUL_BASES.includes(basis)) return { error: `"${basis.slice(0, 40)}" is not one of the six legal bases` };
        patch.lawfulBasis = basis;
    }
    const days = Number(reg.retentionDays);
    const wantsRetention = reg.retentionDays !== undefined && reg.retentionDays !== null && reg.retentionDays !== '';
    if (wantsRetention) {
        if (!Number.isFinite(days) || days < 1 || days > MAX_RETENTION_DAYS) return { error: `a retention period is between 1 and ${MAX_RETENTION_DAYS} days` };
        patch.retentionDays = Math.round(days);
    }
    if (typeof reg.retentionField === 'string' && reg.retentionField) {
        if (keys.size && !keys.has(reg.retentionField)) return { error: `there is no column "${reg.retentionField.slice(0, 63)}" to count the retention from` };
        patch.retentionField = reg.retentionField;
    }
    // The pair, not the number: days without a field is a record nothing acts on.
    if (patch.retentionDays && !patch.retentionField) return { error: 'a retention period needs a date column to count from' };
    if (typeof reg.subjectColumn === 'string' && reg.subjectColumn) {
        // A system stamp names nobody, so this half keeps the declared columns.
        const declared = new Set((Array.isArray(fields) ? fields : []).map((f) => f && f.key).filter(Boolean));
        if (declared.size && !declared.has(reg.subjectColumn)) return { error: `there is no column "${reg.subjectColumn.slice(0, 63)}" to name the person` };
        patch.subjectColumn = reg.subjectColumn;
    }
    if (!Object.keys(patch).length) return { error: 'nothing to record' };
    return { patch };
}

function register(router, ctx) {
    const { d, flow, requireManageApps, runLimiter } = ctx;
    const { load, phaseTier } = flow;

    /**
     * "Resolve with AI" for ONE compliance finding — the proposal, not the fix.
     *
     * Writes nothing. The client shows what it says in words, the person
     * presses Apply, and the calls go out through the endpoints that already
     * own and audit those writes — the same separation the access phase has.
     */
    router.post('/:id/phases/:key/resolve-plan', requireManageApps, runLimiter, async (req, res) => {
        try {
            const pb = await load(req, res);
            if (!pb) return;
            const cur = lifecycle.phaseByKey(pb.phases, req.params.key);
            if (!cur || kindOf(cur) !== 'compliance') return sendErr(res, 400, 'bad_patch', 'That is not a compliance phase.');
            const parsed = check(res, ResolvePlanBody, req.body, 'bad_patch');
            if (!parsed.ok) return;
            const code = parsed.value.code;
            const findings = Array.isArray(cur.artifacts && cur.artifacts.findings) ? cur.artifacts.findings : [];
            const finding = findings.find((f) => f && f.code === code) || null;
            if (!finding) return sendErr(res, 404, 'unknown_finding', 'That finding is not on this review.');
            const facts = (cur.artifacts && cur.artifacts.facts) || null;
            if (!facts) return sendErr(res, 409, 'artifacts_missing', 'This review has no facts to work from.');
            // The planner's tier: the playbook's, measured against the
            // owner's list now (phaseFlow.phaseTier).
            const tier = await phaseTier(req, res, pb);
            if (!tier) return;

            // Whom the model may name: the organisation's directory, never the
            // installation's -- the access assistant's rule (./directory.js).
            // `!orgId || !x.organizationId || …` read a consumer's playbook as
            // "no filter" and let consumers and global groups into every org's.
            const [groups, users] = await Promise.all([
                d.userStore.getAllGroups().catch(() => []),
                d.userStore.getAllUsers().catch(() => []),
            ]);
            const directory = directoryFor(pb, req.session, groups || [], users || []);
            // The automations' definitions, read once and only for the ids this
            // review already knows about.
            const defs = new Map();
            for (const a of (facts.automations || [])) {
                if (!a || !a.id) continue;
                try {
                    const row = await d.automationStore.getAutomation(a.id);
                    if (row && row.userId === pb.userId) defs.set(a.id, row.definition || null);
                } catch { /* one unreadable automation is not the end of the plan */ }
            }

            const out = await d.planResolve({
                tier,
                code,
                finding,
                facts,
                locale: localeOf(pb) || 'en',
                directory: {
                    groups: directory.groups.map((g) => ({ id: g.id, name: g.name })),
                    people: directory.users.map((u) => ({ id: u.id, name: u.name || u.fullName || '', email: u.email || '' })),
                },
                definitionOf: (id) => defs.get(id) || null,
                userId: pb.userId,
                userOrgId: pb.organizationId,
            });
            if (!out.ok) return sendErr(res, 422, out.code, out.error);
            res.json({ plan: out.plan });
        } catch (e) {
            log.error('[Playbooks] resolve plan failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not work that out');
        }
    });

    /**
     * What a retention period would MEAN for the rows that are really there.
     *
     * "Keep for 365 days" is a number until someone checks it against the
     * table: the oldest row may be older than the window, in which case the
     * clean-up will delete on its first pass, or the chosen column may hold no
     * dates at all, in which case the period is recorded and never fires. The
     * person deserves to know which before they press Register, so this reads
     * and answers — it writes nothing (owner, 2026-09-16).
     */
    router.post('/:id/phases/:key/retention-preview', requireManageApps, runLimiter, async (req, res) => {
        try {
            const pb = await load(req, res);
            if (!pb) return;
            const cur = lifecycle.phaseByKey(pb.phases, req.params.key);
            if (!cur || kindOf(cur) !== 'compliance') return sendErr(res, 400, 'bad_patch', 'That is not a compliance phase.');
            const parsed = check(res, RetentionPreviewBody, req.body, 'bad_retention_field');
            if (!parsed.ok) return;
            const body = parsed.value;
            const tableArt = (firstOfKind(pb.phases, 'table') || {}).artifacts || {};
            if (!tableArt.datatableId) return sendErr(res, 409, 'artifacts_missing', 'This playbook has no table.');
            const fields = Array.isArray(tableArt.fields) ? tableArt.fields : [];
            const field = body.retentionField;
            const system = RETENTION_SYSTEM_FIELDS.includes(field);
            const column = system
                ? { key: field, name: field === 'created_at' ? 'When the row was added' : 'When the row last changed', type: 'datetime' }
                : fields.find((f) => f && f.key === field);
            if (!column) return sendErr(res, 400, 'bad_retention_field', `There is no column "${String(field).slice(0, 63)}" in this table.`);
            const days = Number(body.retentionDays);
            if (!Number.isFinite(days) || days < 1 || days > MAX_RETENTION_DAYS) return sendErr(res, 400, 'bad_retention_days', `A retention period is between 1 and ${MAX_RETENTION_DAYS} days.`);

            const principal = await d.datatableAccessPlan.resolveDatatablePrincipalForUser(pb.userId);
            const resolved = await d.datatableRuntime.resolveForPrincipal(tableArt.datatableId, principal, { needed: 'viewer' });
            const allowColumns = [...fields.map((f) => f.key).filter(Boolean), ...RETENTION_SYSTEM_FIELDS];
            const cutoff = new Date(d.now() - Math.round(days) * 86400000).toISOString();
            const span = await d.datatableRuntime.aggregateRows(resolved, {
                allowColumns,
                aggregates: [{ fn: 'min', field, as: 'oldest' }, { fn: 'max', field, as: 'newest' }, { fn: 'count', field: '*', as: 'rows' }],
            });
            const first = (span && span.rows && span.rows[0]) || {};
            const oldest = first.oldest ?? null;
            const newest = first.newest ?? null;
            const rowCount = Number(first.rows ?? 0) || 0;
            let outside = 0;
            if (oldest !== null) {
                const older = await d.datatableRuntime.aggregateRows(resolved, {
                    allowColumns,
                    filters: [{ field, op: 'lt', value: cutoff }],
                    aggregates: [{ fn: 'count', field: '*', as: 'rows' }],
                });
                outside = Number(((older && older.rows && older.rows[0]) || {}).rows ?? 0) || 0;
            }
            // A column with no readable date is the case that matters most:
            // the period would be on record and the clean-up would never act.
            const usable = oldest !== null && !Number.isNaN(Date.parse(String(oldest)));
            res.json({
                retentionField: field,
                retentionFieldName: column.name || field,
                retentionDays: Math.round(days),
                type: column.type || null,
                usable,
                oldest: usable ? oldest : null,
                newest: usable && newest !== null && !Number.isNaN(Date.parse(String(newest))) ? newest : null,
                oldestDays: usable ? Math.max(0, Math.floor((d.now() - Date.parse(String(oldest))) / 86400000)) : null,
                rowCount,
                outsideWindow: outside,
            });
        } catch (e) {
            if (e && e.status) return sendErr(res, e.status, e.code || 'refused', e.message);
            log.error('[Playbooks] retention preview failed:', e.message);
            return sendErr(res, 500, 'server_error', 'Could not read the table.');
        }
    });

    /**
     * REGISTER — the only thing in the compliance phase that writes.
     *
     * The review is a reading; this is the person acting on it. Three writes,
     * each into the register that already owns that fact, none of them new
     * storage invented for a playbook:
     *
     *   1. the TABLE's own metadata (legal basis, retention, subject column) —
     *      which is what puts it in the processing register (compliance/ropa)
     *      AND switches on the retention sweep (jobs/datatableRetention.js);
     *   2. a RISK per finding the person kept, source 'playbook';
     *   3. the review itself as EVIDENCE, hash-chained like every check.
     *
     * Partial success is reported, never rolled back silently: a risk that
     * could not be written must not un-register the table.
     */
    router.post('/:id/phases/:key/register', requireManageApps, runLimiter, async (req, res) => {
        try {
            const pb = await load(req, res);
            if (!pb) return;
            const cur = lifecycle.phaseByKey(pb.phases, req.params.key);
            if (!cur || kindOf(cur) !== 'compliance') return sendErr(res, 400, 'bad_patch', 'That is not a compliance phase.');
            const parsed = check(res, RegisterBody, req.body, 'bad_patch');
            if (!parsed.ok) return;
            const body = parsed.value;
            const orgId = pb.organizationId || 'default';
            const userId = pb.userId;
            const written = [];
            const failed = [];

            // 1. the table
            const tableArt = (firstOfKind(pb.phases, 'table') || {}).artifacts || {};
            const reg = isObject(body.registration) ? body.registration : {};
            // What was really written, and -- if something was asked and not
            // written -- why. The evidence below records THESE, not the request:
            // it used to spread the request into `registered`, so a refused legal
            // basis sat on the hash chain as a registration that never happened.
            let registeredPatch = null;
            let notRegistered = null;
            // `retentionField` counts too: a registration naming only the date
            // column was skipped without a word.
            if (tableArt.datatableId && (reg.lawfulBasis || reg.retentionDays || reg.retentionField || reg.subjectColumn)) {
                const check = validateRegistration(reg, tableArt.fields || []);
                if (check.error) {
                    failed.push({ what: 'processing_register', error: check.error });
                    notRegistered = check.error;
                } else {
                    try {
                        await d.datatableStore.updateDatatableMeta(tableArt.datatableId, tableArt.datatableScope, check.patch);
                        written.push('processing_register');
                        registeredPatch = check.patch;
                    } catch (e) {
                        failed.push({ what: 'processing_register', error: e.message });
                        notRegistered = 'the table could not be updated';
                    }
                }
            }

            // 2. the risks the person kept
            const keep = Array.isArray(body.risks) ? body.risks.slice(0, 20) : [];
            const findings = Array.isArray(cur.artifacts && cur.artifacts.findings) ? cur.artifacts.findings : [];
            let risks = 0;
            for (const code of keep) {
                const f = findings.find((x) => x && x.code === code);
                if (!f) continue;
                try {
                    await d.riskStore.createRisk(orgId, {
                        title: `${f.title} — ${f.subject || pb.title}`.slice(0, 300),
                        description: [f.why, f.fix && `What to do: ${f.fix}`].filter(Boolean).join('\n\n'),
                        category: f.framework || null,
                        likelihood: 3,
                        impact: f.severity === 'high' ? 4 : f.severity === 'medium' ? 3 : 2,
                        source: 'playbook',
                        seed_key: `playbook:${pb.id}:${f.code}`.slice(0, 200),
                        owner_user_id: userId,
                    }, userId);
                    risks += 1;
                } catch (e) {
                    failed.push({ what: `risk:${code}`, error: e.message });
                }
            }
            if (risks) written.push(`risks:${risks}`);

            // 3. the review itself, on the evidence chain
            try {
                await d.complianceStore.addEvidence({
                    organization_id: orgId,
                    check_id: 'PLAYBOOK-review',
                    subject_type: 'playbook',
                    subject_id: pb.id,
                    payload: {
                        playbook: { id: pb.id, title: pb.title, recipe: pb.recipeId },
                        frameworks: (cur.artifacts && cur.artifacts.frameworks) || [],
                        findings: findings.map((f) => ({ code: f.code, severity: f.severity, framework: f.framework, article: f.article, subject: f.subject, title: f.title, source: f.source })),
                        registered: { table: tableArt.datatableId || null, ...(registeredPatch || {}) },
                        ...(notRegistered ? { not_registered: { requested: reg, reason: notRegistered } } : {}),
                        risks_opened: risks,
                        reviewed_by: userId,
                        reviewed_at: new Date(d.now()).toISOString(),
                    },
                });
                written.push('evidence');
            } catch (e) {
                failed.push({ what: 'evidence', error: e.message });
            }

            // The three writes above have already happened. If THIS write loses
            // its CAS the route used to answer 200 with the stale playbook and
            // an empty `failed`, so the phase never recorded the registration
            // and the panel invited a second one — a second evidence row on the
            // chain. Re-read and merge once instead.
            const stamp = { at: new Date(d.now()).toISOString(), written, risks, table: tableArt.datatableId || null };
            const withStamp = (list, key) => list.map((p) => (p.key === key
                ? { ...p, artifacts: { ...(p.artifacts || {}), registered: stamp } }
                : p));
            let saved = await d.playbookStore.savePhases(pb.id, pb.userId, { phases: withStamp(pb.phases, cur.key) }, { expectedVersion: pb.version });
            if (!saved.ok && saved.conflict) {
                const fresh = await d.playbookStore.getPlaybook(pb.id, pb.userId);
                if (fresh) saved = await d.playbookStore.savePhases(fresh.id, fresh.userId, { phases: withStamp(fresh.phases, cur.key) }, { expectedVersion: fresh.version });
            }
            if (!saved.ok) {
                // Say so rather than pretending: the register IS written, the
                // phase could not record it.
                failed.push({ what: 'phase', error: 'The registration was written, but the playbook could not record it — reload before registering again.' });
            }
            res.json({ playbook: saved.ok ? saved.playbook : pb, written, failed });
        } catch (e) {
            log.error('[Playbooks] register failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not register it');
        }
    });
}

module.exports = { register };
