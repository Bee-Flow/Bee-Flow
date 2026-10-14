// @typecheck
/**
 * The rate-limit buckets and the body-size gate of the form surface
 * (routes/automation/formPublic.js). One instance of each bucket, shared by
 * every route that names it, so a bucket counts across the whole surface.
 */

const { perUserRateLimit } = require('../../../utils/perUserRateLimit');

const FORM_RPM_PER_IP = parseInt(process.env.AUTOMATION_FORM_RPM_PER_IP, 10) || 60;
const FORM_RPM_PER_TOKEN = parseInt(process.env.AUTOMATION_FORM_RPM_PER_TOKEN, 10) || 120;
const FORM_UPLOAD_RPM = parseInt(process.env.AUTOMATION_FORM_UPLOAD_RPM, 10) || 12;
// A picker's search box fires on every pause in typing, so its bucket sits
// between the upload bucket and the poll bucket. It is per token AND per
// caller: one person searching hard must not lock a colleague out of the form.
const FORM_PICK_RPM = parseInt(process.env.AUTOMATION_FORM_PICK_RPM, 10) || 40;
// A polling browser is chatty by design (sub-second while the automation works),
// so its bucket is far wider than the submit buckets.
const FORM_POLL_RPM = parseInt(process.env.AUTOMATION_FORM_POLL_RPM, 10) || 300;

// A submission body is answers to at most 40 declared fields; 256KB is already
// generous. Files go through the separate upload call, never through here.
const MAX_SUBMISSION_BYTES = 256 * 1024;

const ipLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_RPM_PER_IP, keyFn: (req) => `formip:${req.ip || 'unknown'}` });
const tokenLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_RPM_PER_TOKEN, keyFn: (req) => `formtok:${req.params.token}` });
const uploadLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_UPLOAD_RPM, keyFn: (req) => `formupload:${req.params.token}:${req.ip || 'unknown'}` });
const pickLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_PICK_RPM, keyFn: (req) => `formpick:${req.params.token}:${req.session?.user?.id || req.ip || 'unknown'}` });
const sessionLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_POLL_RPM, keyFn: (req) => `formsess:${req.params.sid}` });
// Turning a result into a Word or PDF file renders a document (a Chromium
// page for the PDF), so it gets a bucket of its own per person rather than
// riding on the 300/min poll budget.
const FORM_EXPORT_RPM = parseInt(process.env.AUTOMATION_FORM_EXPORT_RPM, 10) || 10;
const exportLimiter = perUserRateLimit({ windowMs: 60_000, max: FORM_EXPORT_RPM, keyFn: (req) => `formexport:${req.session?.user?.id || req.ip || 'unknown'}` });

// Explicit size gate. index.js installs bodyParser.json({limit:'20mb'})
// globally BEFORE this router, so the body is already parsed by the time we
// run and a route-local limit would be dead code.
function contentLengthGuard(req, res, next) {
    const len = Number(req.get('content-length') || 0);
    if (Number.isFinite(len) && len > MAX_SUBMISSION_BYTES) {
        return res.status(413).json({ error: 'That submission is too large' });
    }
    return next();
}

module.exports = {
    MAX_SUBMISSION_BYTES,
    ipLimiter,
    tokenLimiter,
    uploadLimiter,
    pickLimiter,
    sessionLimiter,
    exportLimiter,
    contentLengthGuard,
};
