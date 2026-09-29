/**
 * Mailbox residue in the company inbox: report whether an email box is still
 * feeding it, and let a super-admin cut that mailbox loose and purge the
 * mail-sourced tickets it left behind.
 */

const supportStore = require('../../stores/supportStore');
const { isSuperAdmin } = require('../../auth');

const { requireStaffSupport, _emit } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** The disconnect button posts nothing; a key in its body is a mistake, not a default. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
const log = require('../../telemetry/log');

function register(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // GET  /mailbox            — is an email box feeding this company inbox?
    // POST /mailbox/disconnect — unlink it and purge the tickets it produced
    //
    // Bee Flow's own company inbox has no mailbox connector of its own: it is fed
    // by the marketing form and in-app tickets. Mail-sourced threads can only get
    // here from a Support-studio mailbox whose inbox row is gone — deleteInbox used
    // to detach its threads (inbox_id = NULL), and inbox_id IS NULL is precisely how
    // this inbox is defined, so every email of that mailbox landed in the admin
    // panel. deleteInbox now purges instead; these endpoints clear up what earlier
    // disconnects already spilled here.
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/mailbox', requireStaffSupport, async (req, res) => {
        const summary = await supportStore.getCompanyMailboxSummary();
        res.json({ mailbox: { connected: summary.count > 0, ...summary } });
    });

    router.post('/mailbox/disconnect', validate({ body: NoBody }), async (req, res) => {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Super-admin required' });
        }
        const before = await supportStore.getCompanyMailboxSummary();
        if (!before.count) return res.json({ ok: true, removed: 0 });
        const removed = await supportStore.deleteMailboxThreads({ companyMailbox: true });
        supportStore.recordAuditEvent({
            actorKind: 'staff',
            actorUserId: req.session?.user?.id || null,
            action: 'inbox_disconnected',
            payload: { scope: 'company', purgedThreads: removed },
        }).catch(() => {});
        log.info(`[Support] Company mailbox disconnected — ${removed} mail-sourced thread(s) purged`);
        _emit('threads_purged', { removed });
        res.json({ ok: true, removed });
    });
}

module.exports = { register };
