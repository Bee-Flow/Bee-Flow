/**
 * SLA policies per priority — the first-response and resolution clocks the
 * enforcer measures threads against. Staff read; the acting org decides
 * whether the write lands system-wide or on one tenant.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `SlaBody` is `.strict()`, and the field that needed it most is `enabled`:
 * the route read it as `enabled !== false`, so anything that was not the
 * boolean `false` — the STRING 'false', `0`, `null` — saved the policy as ON.
 * Switching an SLA clock off with a JSON string answered 200 with the clock
 * still running. `priority` now names the four it accepts instead of relying
 * on the store to throw `invalid priority` into the 400 body.
 */

const supportStore = require('../../stores/supportStore');

const { requireStaffSupport, _actingOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const MINUTES_TEXT = (name) => `${name} is a whole number of minutes, at least 1.`;
const minutes = (name) => z.coerce.number({
    required_error: MINUTES_TEXT(name), invalid_type_error: MINUTES_TEXT(name),
}).int(MINUTES_TEXT(name)).min(1, MINUTES_TEXT(name)).max(525600, `${name} is at most a year.`);

const SlaBody = z.object({
    priority: z.enum(PRIORITIES, { errorMap: () => ({ message: `priority is one of: ${PRIORITIES.join(', ')}.` }) }),
    first_response_minutes: minutes('first_response_minutes'),
    resolution_minutes: minutes('resolution_minutes'),
    // The clock is on unless it is switched off, and only a real false does that.
    enabled: z.boolean({ invalid_type_error: 'enabled is true or false.' }).optional(),
}).strict();

function register(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // SLA policies (staff read, super-admin write for system-wide)
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/sla-policies', requireStaffSupport, async (req, res) => {
        try {
            const orgId = await _actingOrgId(req);
            const policies = await supportStore.listSlaPolicies(orgId);
            res.json({ policies });
        } catch (err) {
            log.error('[Support] GET /sla-policies error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.put('/sla-policies', requireStaffSupport, validate({ body: SlaBody }), async (req, res) => {
        try {
            const { priority, first_response_minutes, resolution_minutes, enabled } = req.body;
            const orgId = await _actingOrgId(req);
            const policy = await supportStore.upsertSlaPolicy({
                organizationId: orgId,
                priority,
                firstResponseMinutes: first_response_minutes,
                resolutionMinutes: resolution_minutes,
                enabled: enabled !== false,
            });
            res.json({ ok: true, policy });
        } catch (err) {
            log.error('[Support] PUT /sla-policies error:', err.message);
            res.status(400).json({ error: err.message });
        }
    });
}

module.exports = { register };
