// THE structural authority for the Learning Center course catalog.
//
// The server is the source of truth for STRUCTURE (course ids, lessonIds,
// tracks, prereqs, badges, certificate rules, lesson gates): it recomputes
// completion, badges and certificate eligibility from it, and serves it to the
// client via GET /ai/learning/catalog. The client copy in
// agent-hub/src/components/onboarding/courses.js carries presentation (i18n
// keys, icons, levels) and doubles as the offline fallback — a vitest lockstep
// test (catalogLockstep.test.js) fails the build if the two drift.

// The authored curriculum (2026-09) is the structural source: 20 courses / 85
// lessons generated from scratchpad/curriculum by generate.mjs. The LEGACY_*
// blocks below are the previous hand-written catalog, kept for reference and
// for the two hand-written lessons that still live in lessons.js.
const GEN = require('./catalog.generated');

const TRACKS = ['foundations', 'builder', 'power'];


// Certificates: a track cert needs every course in the track; a count cert needs
// any N completed courses.
const CERTIFICATES = [
    { id: 'cert-foundations', track: 'foundations', title: 'Bee Flow AI Certified — Foundations', level: 'Foundations' },
    { id: 'cert-builder', track: 'builder', title: 'Bee Flow AI Certified — Agent Builder', level: 'Agent Builder' },
    { id: 'cert-practitioner', rule: { type: 'count', n: 4 }, title: 'Bee Flow AI Practitioner', level: 'Practitioner' },
];

// Lesson access gates — mirror of the `gate` field in lessons.js. A permission
// array is ANY-of (same as the client's checkPermission); permission AND feature
// on one gate must BOTH pass. Lessons absent from this map are open to everyone.

// Every lesson id the client may legitimately persist progress for. Includes
// 'effective-prompts', which belongs to no course but is a real lesson.

// Which lesson each AI-coach exercise (rubrics.js) lives in — server-owned so
// exercise passes can be attributed to lessons without trusting the client.

const COURSES = GEN.COURSES;
const LESSON_GATES = GEN.LESSON_GATES;
const LESSON_IDS = GEN.LESSON_IDS;
const EXERCISE_LESSONS = GEN.EXERCISE_LESSONS;

// True when a gate passes for the given permission list + feature predicate.
// Mirrors the client's lessonVisible exactly, including the asymmetry between
// the halves: 'all' wildcard wins; `permission` is ANY-of (several roles open
// the same screen); `permissionsAll` is ALL-of (a lesson that hands the learner
// two separate powers — attaching a skill to an agent is manage_skills AND
// manage_agents); `feature` is ALL-of (every capability the lesson makes the
// learner use has to be in the plan, or the lesson teaches a screen they cannot
// open). `feature` and `permissionsAll` may therefore be lists.
function gatePasses(gate, perms, hasFeature) {
    if (!gate) return true;
    const held = (p) => Array.isArray(perms) && (perms.includes('all') || perms.includes(p));
    if (gate.permission) {
        const required = Array.isArray(gate.permission) ? gate.permission : [gate.permission];
        if (!required.some(held)) return false;
    }
    if (gate.permissionsAll && !gate.permissionsAll.every(held)) return false;
    if (gate.feature && typeof hasFeature === 'function') {
        const required = Array.isArray(gate.feature) ? gate.feature : [gate.feature];
        if (!required.every((f) => hasFeature(f))) return false;
    }
    return true;
}

// { [courseId]: string[] } of the lessons this user can actually access — the
// `visibleByCourse` shape completion.js consumes. Matches the client's
// courseLessons(course, user, hasFeature) filtering.
function buildVisibleByCourse(perms, hasFeature) {
    const visible = {};
    for (const course of COURSES) {
        visible[course.id] = (course.lessonIds || [])
            .filter((id) => gatePasses(LESSON_GATES[id], perms, hasFeature));
    }
    return visible;
}

function getCourse(courseId) { return COURSES.find((c) => c.id === courseId) || null; }
function getCertificate(certId) { return CERTIFICATES.find((c) => c.id === certId) || null; }

// Which lessons the AI practice generator can write fresh questions for —
// served to the client so the "Practice" affordance only shows where it works.
// (practiceTopics requires nothing from this module, so no cycle.)
const { PRACTICE_LESSON_IDS } = require('./practiceTopics');

// The structural payload served by GET /ai/learning/catalog. Version bumps when
// structure changes meaningfully (kept in step with certificates.CATALOG_VERSION).
const CATALOG = {
    version: '2026.1',
    tracks: TRACKS,
    courses: COURSES,
    certificates: CERTIFICATES,
    lessonGates: LESSON_GATES,
    lessonIds: LESSON_IDS,
    practiceLessonIds: PRACTICE_LESSON_IDS,
};

module.exports = {
    TRACKS, COURSES, CERTIFICATES, CATALOG,
    LESSON_GATES, LESSON_IDS, EXERCISE_LESSONS,
    gatePasses, buildVisibleByCourse,
    getCourse, getCertificate,
};
