'use strict';
const log = require('../../telemetry/log');

/**
 * "Test as · group Sales" — the agent editor's preview of somebody else's view.
 *
 * An agent answers differently for different people: a knowledge base shared
 * with Sales is invisible to Marketing, and an agent restricted to Sales is
 * not reachable by Marketing at all. Until now the only way to find that out
 * was to ask a colleague. `asGroup=<groupId>` lets the editor ask the question
 * from their own chair.
 *
 * ── IT SIMULATES ONE THING, AND ONLY DOWNWARDS ──────────────────────
 * The simulation covers exactly two questions:
 *
 *   • KB VISIBILITY — which of the agent's knowledge bases would answer;
 *   • AUDIENCE      — whether a member of that group could open the agent.
 *
 * It does NOT touch connections, permissions, entitlements, datatable grades,
 * memory or anything else. Those are decided elsewhere and stay decided as the
 * person actually pressing the button — the plan's words are "geen impersonatie
 * van verbindingen of permissies", and the pin for it is in
 * `testAs.wiring.test.js`, which fails if `testAs` ever appears in one of
 * those layers.
 *
 * ── NAMING A GROUP NEVER WIDENS ANYTHING ────────────────────────────
 * This is the rule the whole file is built around. `visibleKbIdsFor` runs the
 * ORDINARY filter first — the real person, `filterKbIdsForUser`, unchanged —
 * and then narrows THAT list to what a member of the named group would see.
 * The group filter is fed the already-narrowed list, so the result is a subset
 * of the real one by construction rather than by an intersection somebody
 * could later reorder.
 *
 * The consequence is worth stating plainly: an editor who is not in Sales and
 * cannot read the Sales base sees FEWER answers than a real Sales member
 * would. A "Test as" run can therefore produce a false red. It can never
 * produce a false green, and it can never quote a document to somebody who was
 * not already allowed to read it. Between the two, only one of them is a leak.
 *
 * ── THE OWNER BYPASS IS DROPPED ON PURPOSE ──────────────────────────
 * `canUserAccessKB` and `canSeePublished` both let an owner through before any
 * other rule runs, and the person testing usually IS the owner. Keeping that
 * bypass would answer "yes, Marketing sees this" about the editor's own
 * personal base — the single most reassuring wrong answer this feature could
 * give. So the simulated identity owns nothing (see
 * `kbVisibility.filterKbIdsForGroupMember` and `audienceForTestAs`).
 *
 * ── A SIMULATION THAT CANNOT BE READ SHOWS NOTHING ──────────────────
 * Every failure lands on the narrow side, and none of them silently falls back
 * to "run as yourself":
 *
 *   the group cannot be read      → the request is REFUSED (503). Running the
 *                                   turn anyway and labelling it "as group X"
 *                                   is a claim nobody verified.
 *   the group does not exist, or  → REFUSED (400). One code for both, so the
 *   is not in the caller's reach    existence of another org's group does not
 *                                   leak through the difference.
 *   the runtime gets a `testAs`   → NO knowledge for that turn. Not the real
 *   it cannot parse                 person's knowledge under a group's label.
 *
 * Pure at module scope: no requires, so a turn that loads this pays nothing
 * and a unit test can drive every branch through `deps`.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/testAs.test.js
 */

const MAX_GROUP_ID = 200;
const MAX_GROUP_NAME = 200;

/**
 * The simulated member's identity for `canSeePublished`, which lets an owner
 * through before it looks at a group.
 *
 * A symbol rather than a string or a null: it is not equal to any value an
 * `agents` row can hold, so `owner_id === userId` is false whatever the column
 * contains — including for the person running the preview, who usually IS the
 * owner, and for a row with no owner at all.
 */
const GROUP_MEMBER = Symbol('test-as:group-member');

/** Error codes the routes hand back verbatim. */
const TEST_AS_CODES = {
    invalid: 'test_as_invalid_group',
    notFound: 'test_as_group_not_found',
    unreadable: 'test_as_group_unreadable',
    notAllowed: 'test_as_not_allowed',
};

/** Why a group member could not open the agent. */
const AUDIENCE_REASONS = {
    ok: 'ok',
    unpublished: 'unpublished',
    otherOrg: 'other_org',
    groupRestricted: 'group_restricted',
    unknown: 'unknown',
};

function _str(v, max) {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t.length > max ? t.slice(0, max) : t;
}

/** A group id as it may travel: a non-empty, bounded string, or null. */
function normaliseGroupId(raw) {
    const s = _str(raw, MAX_GROUP_ID);
    return s || null;
}

/**
 * Read a `testAs` off message metadata.
 *
 * Three outcomes, and the middle one is the whole point:
 *   `null`                    nothing was asked for — ordinary chat;
 *   `{ groupId: null, … }`    something WAS asked for and cannot be read;
 *   `{ groupId: 'sales', … }` a usable simulation.
 *
 * Consumers must branch on all three. Collapsing the middle case into the
 * first is precisely "the rights check that passed because a read failed".
 */
function coerceTestAs(raw) {
    if (raw === undefined || raw === null || raw === false || raw === '') return null;
    const broken = { groupId: null, groupName: null, orgId: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) return broken;
    const groupId = normaliseGroupId(raw.groupId);
    if (!groupId) return broken;
    return {
        groupId,
        groupName: _str(raw.groupName, MAX_GROUP_NAME) || null,
        orgId: _str(raw.orgId, MAX_GROUP_ID) || null,
    };
}

/** The shape that travels on the wire and into `agent_test_runs.results`. */
function testAsLabelParts(testAs) {
    const sim = coerceTestAs(testAs);
    if (!sim || !sim.groupId) return null;
    return { groupId: sim.groupId, groupName: sim.groupName || null };
}

/**
 * May this person name this group?
 *
 * A super admin may name any of them. Everybody else may name the groups of
 * their own organisations, plus any group they are personally in — the seeded
 * `admins`/`users` groups carry no `organizationId` at all, so the org test on
 * its own would exclude them for the people who are actually in them.
 *
 * ONE predicate, two consumers: the picker (`listSimulatableGroups`) and the
 * resolver (`resolveTestAs`). Two copies would drift into a picker that offers
 * a group the resolver then refuses, which reads as a broken feature, or —
 * worse the other way round — a list that quietly says who is in what.
 */
function mayNameGroup(group, { orgIds, ownGroups = [] } = {}) {
    if (!group || typeof group.id !== 'string' || !group.id) return false;
    if (orgIds === null) return true;
    if (orgIds instanceof Set && group.organizationId && orgIds.has(group.organizationId)) return true;
    return Array.isArray(ownGroups) && ownGroups.includes(group.id);
}

/** How many groups a picker gets. A workspace with more than this has bigger problems. */
const MAX_SIMULATABLE_GROUPS = 200;

/**
 * The groups this person may preview an agent as — the picker behind
 * "Test as \u00b7 group …".
 *
 * Exposed on a surface that already required the EDIT right on the agent, and
 * scoped by the predicate above. On a failed read it returns `unknown: true`
 * rather than an empty list: "your workspace has no groups" and "I could not
 * look" are different sentences, and only one of them is true.
 */
async function listSimulatableGroups({ userId, orgIds, deps = {} } = {}) {
    const getAllGroups = deps.getAllGroups
        || (() => require('../../stores/userStore').getAllGroups());
    const resolveUserGroups = deps.resolveUserGroups
        || ((uid) => require('../../auth/audience').resolveUserGroups(uid));

    let all;
    let ownGroups = [];
    try {
        [all, ownGroups] = await Promise.all([
            getAllGroups(),
            resolveUserGroups(userId).catch(() => []),
        ]);
    } catch (e) {
        log.error('[TestAs] could not list groups:', e.message);
        return { groups: [], unknown: true };
    }
    if (!Array.isArray(all)) return { groups: [], unknown: true };

    const groups = all
        .filter(g => mayNameGroup(g, { orgIds, ownGroups: Array.isArray(ownGroups) ? ownGroups : [] }))
        .map(g => ({ id: g.id, name: _str(g.name, MAX_GROUP_NAME) || g.id }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_SIMULATABLE_GROUPS);
    return { groups, unknown: false };
}

/**
 * Turn a caller-supplied `asGroup` into a simulation, or refuse.
 *
 * @param {object} p
 * @param {string} p.groupId   raw, from the request body
 * @param {string} p.userId    the person pressing the button
 * @param {Set|null} p.orgIds  `resolveUserOrgIds(req)`; null = super admin
 * @param {object} [p.deps]    { getGroup, resolveUserGroups } — tests only
 * @returns {Promise<{ok:true, testAs:object}|{ok:false, status:number, code:string, error:string}>}
 */
async function resolveTestAs({ groupId, userId, orgIds, deps = {} } = {}) {
    const id = normaliseGroupId(groupId);
    if (!id) {
        return { ok: false, status: 400, code: TEST_AS_CODES.invalid, error: 'Pick a group to test as.' };
    }

    const getGroup = deps.getGroup
        || ((gid) => require('../../stores/userStore').getGroup(gid));
    const resolveUserGroups = deps.resolveUserGroups
        || ((uid) => require('../../auth/audience').resolveUserGroups(uid));

    let group;
    try {
        group = await getGroup(id);
    } catch (e) {
        // Not "assume it is fine": a group we could not read is a group whose
        // org and name we would be guessing, under a label that claims we did
        // not guess.
        log.error('[TestAs] group lookup failed:', e.message);
        return {
            ok: false, status: 503, code: TEST_AS_CODES.unreadable,
            error: 'Could not check that group right now. Try again.',
        };
    }
    if (!group) {
        return { ok: false, status: 400, code: TEST_AS_CODES.notFound, error: 'That group does not exist.' };
    }

    // The same predicate the picker uses. The membership read only happens when
    // the cheap org test has already failed, and a read that throws counts as
    // "not a member" — which refuses, below.
    let allowed = mayNameGroup(group, { orgIds });
    if (!allowed) {
        let own = [];
        try { own = await resolveUserGroups(userId); } catch (_) { own = []; }
        allowed = mayNameGroup(group, { orgIds, ownGroups: own });
    }
    if (!allowed) {
        // Same answer as "no such group". Telling the difference would confirm
        // that another organisation has a group with this id.
        return { ok: false, status: 400, code: TEST_AS_CODES.notFound, error: 'That group does not exist.' };
    }

    return {
        ok: true,
        testAs: {
            groupId: id,
            groupName: _str(group.name, MAX_GROUP_NAME) || id,
            // The org the simulated member belongs to. Null for a group that
            // has none; the KB filter then falls back to the ASKER's own orgs,
            // which keeps the simulation inside the tenant either way.
            orgId: _str(group.organizationId, MAX_GROUP_ID) || null,
        },
    };
}

/**
 * The knowledge-base door, for every retrieval surface in an agent turn.
 *
 * Without a simulation this is exactly what the call sites did before:
 * `askerContext` + `filterKbIdsForUser`. With one, the result is narrowed a
 * second time — never widened, see the module header.
 *
 * @param {string[]} kbIds
 * @param {object} p
 * @param {string} p.userId    the real asker; unchanged by the simulation
 * @param {object} [p.testAs]  raw metadata value, coerced here
 * @param {string} [p.context] for the log line ('agent_chat', 'kb_search', …)
 * @param {string} [p.agentId]
 * @param {object} [p.deps]
 */
async function visibleKbIdsFor(kbIds, {
    userId, testAs = null, context = 'retrieval', agentId = null, deps = {},
} = {}) {
    const ids = Array.isArray(kbIds) ? kbIds.filter(id => typeof id === 'string' && id) : [];
    if (ids.length === 0) return [];

    const sim = coerceTestAs(testAs);
    if (sim && !sim.groupId) {
        log.warn('[TestAs] unreadable simulation — no knowledge this turn', JSON.stringify({ context, agentId }));
        return [];
    }

    const askerContext = deps.askerContext || require('../kb/askerContext').askerContext;
    const kbVisibility = deps.kbVisibility || require('../kb/kbVisibility');

    // Handed to both filters so a test can drive the REAL rules over a fake
    // table instead of faking the rules.
    const kbDeps = deps.kbStore ? { kbStore: deps.kbStore } : {};

    const asker = await askerContext(userId);
    const real = await kbVisibility.filterKbIdsForUser(ids, {
        userId, orgIds: asker.orgIds, userGroups: asker.userGroups, context, agentId, deps: kbDeps,
    });
    if (!sim || real.length === 0) return real;

    // Fed the ALREADY-narrowed list, so what comes back is a subset of what
    // this person may read no matter what the group filter decides.
    const orgIds = sim.orgId ? new Set([sim.orgId]) : asker.orgIds;
    const kept = new Set(await kbVisibility.filterKbIdsForGroupMember(real, {
        orgIds, groupId: sim.groupId, context: `${context}_test_as`, agentId, deps: kbDeps,
    }));
    return real.filter(id => kept.has(id));
}

/**
 * Could a member of the simulated group open this agent at all?
 *
 * Reported, never enforced: the editor is allowed to run their own tests
 * against their own agent, and a run that refused to start would answer a
 * different question than the one asked. But it has to be SAID — nine green
 * answers from an agent that group cannot reach is a fact worth knowing.
 *
 * @param {object} agent      the concept row (owner_id, organization_id,
 *                            is_published, shared_groups)
 * @param {object} testAs
 * @param {object} p
 * @param {Set|null} [p.orgIds]  the asker's orgs; used when the group has none
 * @returns {{visible:boolean, reason:string}}
 */
function audienceForTestAs(agent, testAs, { orgIds = null, deps = {} } = {}) {
    const sim = coerceTestAs(testAs);
    if (!agent || !sim || !sim.groupId) return { visible: false, reason: AUDIENCE_REASONS.unknown };

    const askerOrgs = orgIds instanceof Set ? orgIds : new Set();
    const orgSet = sim.orgId ? new Set([sim.orgId]) : askerOrgs;

    const canSeePublished = deps.canSeePublished
        || require('../../auth/audience').canSeePublished;

    // The simulated member owns nothing — see GROUP_MEMBER. Without that,
    // `canSeePublished` lets the editor's own agent through before it ever
    // looks at the group, and the preview says "yes, Marketing can open this"
    // about an unpublished draft.
    let visible = false;
    try {
        visible = canSeePublished(agent, {
            userId: GROUP_MEMBER, orgIds: orgSet, userGroups: [sim.groupId],
        });
    } catch (_) {
        return { visible: false, reason: AUDIENCE_REASONS.unknown };
    }
    if (visible) return { visible: true, reason: AUDIENCE_REASONS.ok };
    if (!agent.is_published) return { visible: false, reason: AUDIENCE_REASONS.unpublished };
    if (!agent.organization_id || !orgSet.has(agent.organization_id)) {
        return { visible: false, reason: AUDIENCE_REASONS.otherOrg };
    }
    return { visible: false, reason: AUDIENCE_REASONS.groupRestricted };
}

/**
 * The whole request-side dance both routes do: is `asGroup` even there, may
 * this caller ask for it, and does the group resolve?
 *
 * Returns `{ ok:true, testAs:null }` when nothing was asked for — the ONLY way
 * a null testAs comes back with `ok`. Every other path either resolves or
 * refuses; there is no branch where a caller asked for a simulation and gets a
 * plain run.
 *
 * @param {object} p
 * @param {*} p.asGroup          req.body.asGroup
 * @param {string} p.userId
 * @param {Set|null} p.orgIds
 * @param {boolean} p.canEdit    "Test as" is an editor's tool, not a chatter's
 * @param {object} [p.deps]
 */
async function gateTestAsRequest({ asGroup, userId, orgIds, canEdit, deps = {} } = {}) {
    if (asGroup === undefined || asGroup === null || asGroup === '' || asGroup === false) {
        return { ok: true, testAs: null };
    }
    if (!canEdit) {
        return {
            ok: false, status: 403, code: TEST_AS_CODES.notAllowed,
            error: 'Only someone who can edit this agent can test as a group.',
        };
    }
    return resolveTestAs({ groupId: asGroup, userId, orgIds, deps });
}

module.exports = {
    MAX_GROUP_ID, MAX_GROUP_NAME, TEST_AS_CODES, AUDIENCE_REASONS, GROUP_MEMBER,
    MAX_SIMULATABLE_GROUPS,
    normaliseGroupId, coerceTestAs, testAsLabelParts,
    mayNameGroup, listSimulatableGroups, resolveTestAs, gateTestAsRequest,
    visibleKbIdsFor, audienceForTestAs,
};
