/**
 * Required training — an organisation may insist a course is finished before a
 * feature can be used.
 *
 * "New people ship a broken automation in week one" is an onboarding problem, not
 * a permissions problem: the role is right, the training is missing. So this is
 * a THIRD axis beside the two the product already has. A permission says who
 * you are, a capability says what the plan includes, and a training gate says
 * whether you have been shown how — and unlike the other two, the person it
 * blocks can lift it themselves, in an afternoon, without asking anybody.
 *
 * What it locks, and what it deliberately does not:
 *
 *   • WRITES ONLY. Reading is never gated. Somebody who has not finished the
 *     agents course still talks to agents, opens Studio, and watches what their
 *     colleagues built — they just cannot create or change one yet. A gate that
 *     blanked the screen would teach them nothing and cost them their workday.
 *   • ORG ADMINS ARE NEVER GATED. They set the rule; locking themselves out of
 *     their own workspace behind a course they also have to administer is a
 *     support ticket, not a policy. (`all` — the super-admin wildcard — likewise.)
 *
 * And three ways it refuses to bite, all of them the same principle: a gate
 * nobody can satisfy is worse than no gate at all.
 *
 *   • NO LEARNING CENTER, NO GATE. The Academy is a licensed capability. If the
 *     org's plan drops it, every course becomes unreachable — so the gates go
 *     with it rather than stranding the whole org behind courses that no longer
 *     open.
 *   • A COURSE THE LEARNER CANNOT SEE DOES NOT GATE THEM. Course completion is
 *     computed over the lessons that learner can actually access (their role and
 *     the org's plan), exactly as badges are. If the gating course has no
 *     visible lessons for them at all, it cannot be finished, so it is skipped.
 *   • DEGRADED LOOKUPS FAIL OPEN. If permissions or entitlements are having a
 *     bad day, work continues. That is the opposite of the fail-CLOSED rule in
 *     visibility.js, and deliberately so: there, failing closed withholds a
 *     certificate the user can collect a minute later; here, failing closed
 *     would stop an organisation from working during an outage.
 *
 * Storage: configStore key `org_training_gates_<orgId>`, shape
 *   { areas: { [areaId]: courseId }, updatedAt, updatedBy }
 * Presence of an areaId means it is enforced; the value is which course lifts
 * it. An empty/missing row means no gating, which is the default.
 */

const configStore = require('../stores/configStore');
const { COURSES } = require('./courseCatalog');

const CONFIG_KEY_PREFIX = 'org_training_gates_';
const CACHE_TTL_MS = 30_000;

/**
 * The lockable areas.
 *
 * An area is a thing a person DOES, not a screen and not a capability — "create
 * an agent", not "the Agents tab". `defaultCourseId` is what the admin toggle
 * preselects; they may point an area at any course the org has, including one
 * they authored themselves.
 *
 * `capability` is the licence capability the area already sits behind, or null.
 * It is recorded so the admin UI can hide an area the org cannot use anyway —
 * offering to gate training for App Studio on a plan without App Studio is
 * noise.
 */
const TRAINING_AREAS = Object.freeze([
    Object.freeze({
        id: 'agents', defaultCourseId: 'course-build-agent', capability: null,
        labelFallback: 'Creating and editing agents',
        labelKey: 'learn.training_area.agents',
    }),
    Object.freeze({
        id: 'knowledge', defaultCourseId: 'course-agent-knowledge', capability: null,
        labelFallback: 'Creating and editing knowledge bases',
        labelKey: 'learn.training_area.knowledge',
    }),
    Object.freeze({
        id: 'skills', defaultCourseId: 'course-skills-automation', capability: 'skills',
        labelFallback: 'Creating and editing skills',
        labelKey: 'learn.training_area.skills',
    }),
    Object.freeze({
        id: 'automations', defaultCourseId: 'course-automations-mastery', capability: 'automations',
        labelFallback: 'Creating and editing automations',
        labelKey: 'learn.training_area.automations',
    }),
    Object.freeze({
        id: 'datatables', defaultCourseId: 'course-data-and-forms', capability: 'automations',
        labelFallback: 'Creating and editing datatables',
        labelKey: 'learn.training_area.datatables',
    }),
    Object.freeze({
        id: 'apps', defaultCourseId: 'course-apps', capability: 'app_studio',
        labelFallback: 'Building apps in App Studio',
        labelKey: 'learn.training_area.apps',
    }),
    Object.freeze({
        id: 'webpages', defaultCourseId: 'course-apps', capability: 'webpages',
        labelFallback: 'Publishing web pages',
        labelKey: 'learn.training_area.webpages',
    }),
    Object.freeze({
        id: 'playbooks', defaultCourseId: 'course-playbooks-solutions', capability: 'app_studio',
        labelFallback: 'Running playbooks and bundling solutions',
        labelKey: 'learn.training_area.playbooks',
    }),
    Object.freeze({
        id: 'meeting_notes', defaultCourseId: 'course-meeting-notes', capability: 'meeting_notes',
        labelFallback: 'Recording and uploading meetings',
        labelKey: 'learn.training_area.meeting_notes',
    }),
    Object.freeze({
        id: 'cowork', defaultCourseId: 'course-cowork', capability: null,
        labelFallback: 'Delegating work in Cowork',
        labelKey: 'learn.training_area.cowork',
    }),
]);

const AREA_BY_ID = new Map(TRAINING_AREAS.map((a) => [a.id, a]));
const configKey = (orgId) => `${CONFIG_KEY_PREFIX}${orgId}`;

// ── Stored settings ──────────────────────────────────────────────────────

const cache = new Map(); // orgId → { value, ts }

/**
 * Normalise a stored row into { areas: { [areaId]: courseId } }.
 *
 * Drops unknown area ids and unknown course ids rather than trusting the row:
 * an area retired from TRAINING_AREAS, or a course deleted after an admin
 * pointed a gate at it, must not leave behind a rule that can never be
 * satisfied. Org-authored courses are not in COURSES, so a course id is kept
 * when `knownCourseIds` says nothing about it — validation happens on write.
 */
function normalizeSettings(raw) {
    const areas = {};
    const src = raw && typeof raw === 'object' ? (raw.areas || {}) : {};
    for (const [areaId, courseId] of Object.entries(src)) {
        if (!AREA_BY_ID.has(areaId)) continue;
        if (typeof courseId !== 'string' || !courseId) continue;
        areas[areaId] = courseId;
    }
    return { areas, updatedAt: raw?.updatedAt || null, updatedBy: raw?.updatedBy || null };
}

async function getSettings(orgId) {
    if (!orgId) return { areas: {}, updatedAt: null, updatedBy: null };
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
    let raw = null;
    try { raw = await configStore.getConfig(configKey(orgId)); } catch (_) { raw = null; }
    const value = normalizeSettings(raw);
    cache.set(orgId, { value, ts: Date.now() });
    return value;
}

async function setSettings(orgId, areas, actorId = null) {
    if (!orgId) throw new Error('orgId is required');
    const value = normalizeSettings({ areas });
    value.updatedAt = new Date().toISOString();
    value.updatedBy = actorId;
    await configStore.setConfig(configKey(orgId), value);
    cache.delete(orgId);
    return value;
}

function invalidate(orgId) { if (orgId) cache.delete(orgId); else cache.clear(); }

// ── Completion ───────────────────────────────────────────────────────────

/**
 * Has this user finished `courseId`?
 *
 * Over the lessons they can actually SEE, exactly like badges — otherwise a
 * course containing one lesson their plan hides could never be completed, and
 * the gate would be permanent. `visibleByCourse` comes from
 * learning/visibility.js; when it is undefined (a degraded lookup) the answer
 * is `null`, meaning "unknown", and every caller treats unknown as pass.
 *
 * `extraCourses` carries org-authored courses so a gate may point at one.
 */
function courseSatisfied(courseId, progressMap, visibleByCourse, extraCourses = []) {
    const course = [...COURSES, ...extraCourses].find((c) => c.id === courseId);
    if (!course) return null;                       // course vanished → cannot gate
    if (visibleByCourse === undefined) return null; // degraded → cannot gate
    const required = visibleByCourse[course.id] ?? course.lessonIds ?? [];
    if (!required.length) return null;              // nothing visible to finish
    const done = required.filter((id) => {
        const entry = progressMap && progressMap[id];
        return !!(entry && (entry.completedAt || entry === true));
    });
    return { satisfied: done.length === required.length, done: done.length, total: required.length };
}

/**
 * The full picture for one user: every area, whether it is enforced, and how
 * far along they are. Drives both the admin panel and the client's proactive
 * locks — the point of shipping this to the client is that a create button can
 * be locked with an explanation BEFORE it is pressed, rather than the person
 * composing a whole agent and meeting a 403 at Save.
 */
function evaluateAreas({ settings, progressMap, visibleByCourse, extraCourses = [], isOrgAdmin = false, learningAvailable = true }) {
    const out = {};
    const byId = new Map([...COURSES, ...extraCourses].map((c) => [c.id, c]));
    for (const area of TRAINING_AREAS) {
        const courseId = settings?.areas?.[area.id];
        if (!courseId) { out[area.id] = { enforced: false, satisfied: true }; continue; }
        if (isOrgAdmin || !learningAvailable) {
            out[area.id] = { enforced: false, satisfied: true, courseId, exempt: true };
            continue;
        }
        const state = courseSatisfied(courseId, progressMap, visibleByCourse, extraCourses);
        const course = byId.get(courseId);
        out[area.id] = state === null
            ? { enforced: false, satisfied: true, courseId, exempt: true }
            : {
                enforced: true,
                satisfied: state.satisfied,
                courseId,
                courseTitle: course?.title || courseId,
                lessonsDone: state.done,
                lessonsTotal: state.total,
            };
    }
    return out;
}

module.exports = {
    TRAINING_AREAS,
    AREA_BY_ID,
    CONFIG_KEY_PREFIX,
    configKey,
    normalizeSettings,
    getSettings,
    setSettings,
    invalidate,
    courseSatisfied,
    evaluateAreas,
};
