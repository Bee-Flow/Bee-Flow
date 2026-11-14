// @typecheck strict
/**
 * Who may open a hosted form, and what a token or a session id resolves to.
 *
 * Every route of the form surface (routes/automation/formPublic.js) starts
 * here: `loadForm` turns `:token` into the live automation and its form
 * trigger (or answers the same 404 for every miss), `loadSession` turns
 * `:sid` into the visitor's session, and the run helpers read the CURRENT leg
 * of that session's journey. Nothing in here registers a route.
 */

const automationStore = require('../../../stores/automationStore');
const { audienceAdmits, needsGroups } = require('../../../auth/formAudience');
const { fallback } = require('../../../utils/bestEffort');

/**
 * Whether a form is servable to anonymous visitors.
 *
 * `false` makes every endpoint of the form surface require a signed-in caller who belongs to
 * the organisation that owns the form (see callerMayOpen). Applied as router
 * middleware (in formPublic.js) rather than by moving the mount in routes/automation.js, so the
 * flattened route order — which is the contract automation.routetable.test.js
 * pins — does not change when this is flipped either way.
 */
const PUBLIC_FORMS_ENABLED = false;

/** @typedef {NonNullable<Awaited<ReturnType<typeof automationStore.getAutomation>>>} StoredAutomation */
/** @typedef {{ id?: string, kind?: string, form?: { title?: string } & Record<string, unknown> } & Record<string, unknown>} FormTrigger */

// Session-id shape gate, same discipline as the token: cheap reject before any DB work.
const SESSION_RE = /^[a-f0-9]{24,64}$/;

/**
 * No caching, no indexing — a form URL is a credential.
 * @param {import('express').Response} res
 */
function privateHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('X-Robots-Tag', 'noindex, nofollow');
}

/**
 * Resolve `:token` to { page, automation, definition } or answer and return
 * null. A closed/draft automation and an unknown token look the SAME from the
 * outside (404): the token is the credential, so probing must not distinguish
 * "wrong token" from "form paused". The one exception is a caller who may EDIT
 * the automation: they get 409 form_not_live, because "not available" told the
 * author nothing (studio F10). They already know the form exists.
 *
 * A TEST LINK's row (page.isTest, formTestPageStore.mts) is loadTestForm's.
 * @param {import('express').Request<{ token: string }>} req
 * @param {import('express').Response} res
 */
async function loadForm(req, res) {
    const token = String(req.params.token || '');
    // Cheap shape gate before any DB work: the token is 48 hex chars.
    if (!/^[a-f0-9]{24,64}$/.test(token)) return notFound(res);
    const page = await automationStore.getFormPage(token);
    if (!page) return notFound(res);
    const stored = await automationStore.getAutomation(page.automationId);
    if (page.isTest) return loadTestForm(req, res, token, page, stored);
    if (!stored || !stored.isActive || stored.isDraft) {
        if (stored && await callerMayEdit(req, stored)) {
            res.status(409).json({
                error: 'This form is not live yet. Activate the automation, or test it from the builder or with a test link.',
                code: 'form_not_live', isActive: !!stored.isActive, isDraft: !!stored.isDraft, automationId: stored.id,
            });
            return null;
        }
        return notFound(res);
    }
    // Visitors get the LIVE form (handoff 5): questions saved in the builder
    // but not yet published are not served, and the run executes the same
    // copy the page was rendered from.
    const automation = require('../../../core/automationRunner/definitionForRun').automationForRun(stored, { mode: 'live' });
    const trigger = formTriggerOf(automation, page);
    if (!trigger) return notFound(res);
    if (!PUBLIC_FORMS_ENABLED && !(await callerMayOpen(req, page))) {
        // 404, not 403: the same answer an unknown token gets, so probing
        // cannot tell "not yours" from "does not exist".
        return notFound(res);
    }
    return { token, page, automation, trigger, definition: { trigger }, test: false };
}

/**
 * A test link (D3): the automation's WORKING copy, served to the people its
 * own audience admits (default: the person who made it, and the owner),
 * whether or not the automation is live. Every submission through it is a
 * test run (automation/formSubmission.mts). Expired, revoked, not yours, or
 * no form trigger in the working copy: the same 404 as an unknown token. The
 * organisation stays the outer wall (callerMayOpen), and a test link is never
 * anonymous, whatever PUBLIC_FORMS_ENABLED says.
 * @param {import('express').Request<{ token: string }>} req
 * @param {import('express').Response} res
 * @param {string} token
 * @param {NonNullable<Awaited<ReturnType<typeof automationStore.getFormPage>>>} page
 * @param {StoredAutomation | null} stored
 */
async function loadTestForm(req, res, token, page, stored) {
    const expired = page.expiresAt != null && new Date(page.expiresAt).getTime() <= Date.now();
    if (!stored || expired) return notFound(res);
    if (!(await callerMayOpen(req, page))) return notFound(res);
    const automation = require('../../../core/automationRunner/definitionForRun').automationForRun(stored, { mode: 'live', isTest: true });
    const trigger = formTriggerOf(automation, page);
    if (!trigger) return notFound(res);
    return { token, page, automation, trigger, definition: { trigger }, test: true };
}

/**
 * The form trigger a page row serves, or null. The page row survives the
 * author changing the trigger kind; the form simply stops existing then.
 * @param {{ definition?: unknown }} automation
 * @param {{ triggerStepId?: string | null }} page
 * @returns {FormTrigger | null}
 */
function formTriggerOf(automation, page) {
    const definition = /** @type {{ trigger?: FormTrigger, triggers?: FormTrigger[] }} */ (automation.definition || {});
    const trigger = page.triggerStepId
        ? [definition.trigger, ...(definition.triggers || [])].find((t) => t?.id === page.triggerStepId)
        : definition.trigger;
    return trigger && trigger.kind === 'form' ? trigger : null;
}

/**
 * The one "not found" of the form surface.
 * @param {import('express').Response} res
 * @returns {null}
 */
function notFound(res) {
    res.status(404).json({ error: 'Not found' });
    return null;
}

/**
 * May this signed-in caller EDIT the automation behind a form (owner, org
 * admin, edit share)? Asked only once the form is known not to be live.
 * @param {import('express').Request} req
 * @param {StoredAutomation} stored
 */
async function callerMayEdit(req, stored) {
    const userId = req.session?.user?.id;
    if (!userId) return false;
    const { makeAutomationAccess, roleSatisfies } = require('../../../automation/access');
    const access = await makeAutomationAccess().roleFor(stored, userId, { session: req.session || null });
    return roleSatisfies(access.role, 'edit');
}

/**
 * May this signed-in caller open this form?
 *
 * The organisation is the outer boundary — nobody outside the owner's
 * organisation, ever; without an organisation on the owner the form is the
 * owner's alone (lumping every orgless account together would make a shared
 * install leakier than the public link this replaced). Inside it, the page
 * row's AUDIENCE decides (automation-form-audience-2026-09): everyone in the
 * organisation, or only the people and groups the owner shared it with.
 * The rule itself is the store's `audienceAdmits`, so the visitor gate and
 * the `canOpen` flag of GET /api/automation/forms cannot drift apart.
 * @param {import('express').Request} req
 * @param {NonNullable<Awaited<ReturnType<typeof automationStore.getFormPage>>>} page
 */
async function callerMayOpen(req, page) {
    const caller = req.session?.user;
    if (!caller) return false;
    const audience = await automationStore.formPageAudience(page.id);
    if (!audience) return false;
    // Without groups first: the owner, an org-wide form and a person listed
    // by id are answered without a second read. Group membership is read
    // fresh only when the answer still depends on it.
    if (audienceAdmits(audience, caller, [])) return true;
    if (!needsGroups(audience, caller)) return false;
    const { resolveUserGroups } = require('../../../auth/audience');
    return audienceAdmits(audience, caller, await resolveUserGroups(caller.id));
}

/**
 * The page a session's run is currently PAUSED on, or null.
 *
 * Everything is derived at read time from the run row + its step rows: the
 * session carries no status of its own, so there is no second state machine to
 * fall out of sync with the runner.
 * @param {NonNullable<Awaited<ReturnType<typeof loadForm>>>} found
 * @param {string} sid
 */
async function loadSession(found, sid) {
    if (!SESSION_RE.test(String(sid || ''))) return null;
    const session = await automationStore.getFormSession(sid, found.token);
    if (!session) return null;
    // Belt and braces: the session's automation must be the one this token
    // resolves to, even if a page row were ever re-pointed.
    if (session.automationId !== found.automation.id) return null;
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) return { session, expired: true };
    return { session, expired: false };
}

/**
 * The leg of the journey that is CURRENT for this session.
 *
 * The session is pointed at each run as it is created, so normally this is just
 * that run. But a journey can also be continued by something the session never
 * hears about — an owner approving a paused step from the run history spawns a
 * child and finalises the parent to 'success' — and reading the session's own
 * run then would tell the visitor "done" while the automation is still going.
 * Newest leg of the same journey, always.
 * @param {NonNullable<Awaited<ReturnType<typeof automationStore.getFormSession>>>} session
 */
async function currentRunFor(session) {
    if (!session?.runId) return null;
    return automationStore.getLatestRunInChain(session.runId);
}

/**
 * Every run of this session's journey — the first submission plus every leg
 * that continued it after a pause.
 *
 * This is the access boundary for downloads: a visitor may fetch a document
 * their OWN journey produced, and nothing else. Holding a file id proves
 * nothing on its own.
 * @param {NonNullable<Awaited<ReturnType<typeof automationStore.getFormSession>>>} session
 */
async function journeyRunIds(session) {
    if (!session?.runId) return [];
    const runs = await automationStore.getRunsInChain(session.runId).catch((e) => fallback('routes/automation/formPublic/access:journeyRunIds', e, []));
    return runs.flatMap(r => (r ? [r.id] : []));
}

/**
 * The rendered page the given session's run is waiting on, or null.
 * @param {NonNullable<Awaited<ReturnType<typeof automationStore.getFormSession>>>} session
 * @param {Awaited<ReturnType<typeof currentRunFor>>} [currentRun]
 */
async function pendingPageFor(session, currentRun = null) {
    if (!session?.runId) return null;
    const run = currentRun || await currentRunFor(session);
    if (!run || run.status !== 'awaiting_form' || !run.awaitingStepId) return null;
    const steps = await automationStore.getRunSteps(run.id);
    const row = steps.find(s => s && s.stepId === run.awaitingStepId && s.status === 'awaiting_form');

    const form = row?.output?.form;
    if (!form) return null;
    return { session, run, stepId: run.awaitingStepId, form };
}

module.exports = {
    PUBLIC_FORMS_ENABLED,
    privateHeaders,
    loadForm,
    callerMayOpen,
    loadSession,
    currentRunFor,
    journeyRunIds,
    pendingPageFor,
};
