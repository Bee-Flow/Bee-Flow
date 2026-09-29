/**
 * Customer satisfaction: the staff-facing CSAT + SLA dashboard aggregates and
 * the public landing page the star/dispute links in the resolution email hit.
 *
 * ── Why GET /csat/:threadId has no schema ────────────────────────
 *
 * It is a page a customer's browser NAVIGATES to from a link in an email, and
 * it answers HTML — the whole route exists to render `_csatHtml`. A schema
 * refusal travels to the terminal error handler, which answers JSON, so a
 * mistyped link would put `{"error": "…", "correlationId": "…"}` on the screen
 * of someone who was only rating a support ticket. The three query params are
 * covered where it counts instead: the score is re-derived and the HMAC in
 * `token` is verified against it, so a changed score is a 403 with a page,
 * and anything unparseable is the same 400 with a page.
 */

const supportStore = require('../../stores/supportStore');

const { _shortId, requireStaffSupport, _csatHtml, _emit, notifyStaff } = require('./shared');
const { threadReadLimiter } = require('./rateLimits');
const log = require('../../telemetry/log');

function register(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // GET /insights — CSAT + SLA dashboard aggregates (staff)
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/insights', requireStaffSupport, async (req, res) => {
        try {
            const insights = await supportStore.getInsights({ inboxIsNull: true });
            res.json(insights);
        } catch (err) {
            log.error('[Support] GET /insights error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /csat/:threadId — PUBLIC. Records a CSAT vote or dispute via HMAC token.
    // Links live in the resolution email; no session required.
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/csat/:threadId', threadReadLimiter, async (req, res) => {
        try {
            const { score, dispute, token } = req.query;
            const thread = await supportStore.getThread(req.params.threadId);
            if (!thread) return res.status(404).send(_csatHtml({ error: 'Thread not found.' }));

            const numScore = dispute ? 0 : parseInt(score, 10);
            if (!Number.isInteger(numScore) || numScore < 0 || numScore > 5) {
                return res.status(400).send(_csatHtml({ error: 'Invalid request.' }));
            }
            if (!supportStore.verifyCsatToken(thread.id, thread.requester_email, numScore, token)) {
                return res.status(403).send(_csatHtml({ error: 'This link is invalid or expired.' }));
            }

            if (dispute) {
                await supportStore.disputeResolution(thread.id);
                await supportStore.recordThreadEvent({
                    threadId: thread.id, actorUserId: null, actorKind: 'requester',
                    action: 'resolution_disputed', payload: {},
                });
                notifyStaff({
                    title: `Reopened by customer: ${thread.subject}`,
                    message: 'Customer indicated the issue was not resolved.',
                    threadId: thread.id,
                    category: 'urgent',
                });
                _emit('thread_updated', { threadId: thread.id });
                return res.send(_csatHtml({ disputed: true }));
            }

            await supportStore.setCsat({ threadId: thread.id, score: numScore });
            await supportStore.confirmResolution(thread.id);
            await supportStore.recordThreadEvent({
                threadId: thread.id, actorUserId: null, actorKind: 'requester',
                action: 'csat', payload: { score: numScore },
            });
            _emit('thread_updated', { threadId: thread.id });
            res.send(_csatHtml({ score: numScore }));
        } catch (err) {
            log.error(`[Support] GET /csat/:threadId error (id=${_shortId(req.params.threadId)}):`, err.message);
            res.status(500).send(_csatHtml({ error: 'Something went wrong.' }));
        }
    });
}

module.exports = { register };
