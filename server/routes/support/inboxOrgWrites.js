/**
 * Tenant Support Inbox: the org-scoped tag taxonomy, canned replies and
 * SLA policies the tenant Support studio owns. Split out of
 * routes/supportInbox.js; behaviour unchanged.
 */

const supportStore = require('../../stores/supportStore');
const access = require('../../support/access');
const audit = require('../../support/audit');
const { HttpError } = require('../../core/http/errors');
const { getUserId } = require('./inboxScope');

// ── Org-scoped Templates & SLA writes (tenant-owned) ──────────────────────────
// The tenant Support studio owns its own tag taxonomy, canned replies and SLA
// policies. (Reads live on GET /tags, /canned, /sla-policies; the super-admin
// /api/support/* namespace is for Bee Flow's own company inbox only.)

async function _firstWritableOrg(req) {
    const { scope } = await access.resolveOrgScope(req);
    return scope[0] || null;
}

// These writes used to answer every failure with a 400 carrying err.message:
// a dropped database connection read as the caller's mistake, and a unique
// violation handed the client the index name. The refusals a caller can cause
// keep their 400 and their sentence; anything else goes to the terminal error
// handler, which logs it and answers a generic 500 with a correlationId.
const STORE_REFUSALS = new Set(['tag name required', 'title required', 'body required', 'invalid priority']);
function _studioWriteError(err, duplicate = null) {
    if (err?.expose === true) return err;
    if (typeof err?.message === 'string' && STORE_REFUSALS.has(err.message)) {
        return new HttpError(400, 'invalid_input', err.message);
    }
    if (err?.code === '23505' && duplicate) return new HttpError(400, 'duplicate', duplicate);
    // A path id that is not a uuid.
    if (err?.code === '22P02') return new HttpError(400, 'invalid_id', 'Invalid id');
    return err;
}

async function createTag(req, res) {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { name, color, description } = req.body || {};
        if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
        const tag = await supportStore.createTag({ organizationId: orgId, name: name.trim(), color: color || null, description: description || null });
        audit.emit(req, { organizationId: orgId, action: 'tag_created', payload: { name: tag.name } });
        res.json({ tag });
    } catch (err) { throw _studioWriteError(err, 'tag already exists'); }
}

async function deleteTag(req, res) {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        await supportStore.deleteTag(req.params.id, orgId);
        audit.emit(req, { organizationId: orgId, action: 'tag_deleted', payload: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) { throw _studioWriteError(err); }
}

async function createCanned(req, res) {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { title, body, shortcut } = req.body || {};
        const canned = await supportStore.createCannedResponse({ organizationId: orgId, title, body, shortcut: shortcut || null, createdBy: getUserId(req) });
        audit.emit(req, { organizationId: orgId, action: 'canned_created', payload: { id: canned.id, title: canned.title } });
        res.json({ canned });
    } catch (err) { throw _studioWriteError(err, 'shortcut already in use'); }
}

async function updateCanned(req, res) {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { title, body, shortcut } = req.body || {};
        const canned = await supportStore.updateCannedResponse(req.params.id, { title, body, shortcut }, orgId);
        if (!canned) return res.status(404).json({ error: 'Canned response not found' });
        audit.emit(req, { organizationId: orgId, action: 'canned_updated', payload: { id: req.params.id } });
        res.json({ canned });
    } catch (err) { throw _studioWriteError(err, 'shortcut already in use'); }
}

async function deleteCanned(req, res) {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        await supportStore.deleteCannedResponse(req.params.id, orgId);
        audit.emit(req, { organizationId: orgId, action: 'canned_deleted', payload: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) { throw _studioWriteError(err); }
}

async function listSlaPolicies(req, res) {
    const { scope } = await access.resolveOrgScope(req);
    const orgId = scope[0] || null;
    const policies = await supportStore.listSlaPolicies(orgId);
    res.json({ policies });
}

async function putSlaPolicy(req, res) {
    try {
        const orgId = await _firstWritableOrg(req);
        if (!orgId) return res.status(403).json({ error: 'No organisation in scope' });
        const { priority, firstResponseMinutes, resolutionMinutes, enabled } = req.body || {};
        const policy = await supportStore.upsertSlaPolicy({
            organizationId: orgId, priority,
            firstResponseMinutes: parseInt(firstResponseMinutes, 10),
            resolutionMinutes: parseInt(resolutionMinutes, 10),
            enabled: enabled !== false,
        });
        audit.emit(req, { organizationId: orgId, action: 'sla_policy_changed', payload: { priority } });
        res.json({ policy });
    } catch (err) { throw _studioWriteError(err); }
}

module.exports = { createTag, deleteTag, createCanned, updateCanned, deleteCanned, listSlaPolicies, putSlaPolicy };
