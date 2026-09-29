/**
 * Unit tests — Learning Center completion / badge / certificate math.
 *
 * completion.js is pure (no stores, no network), so these tests pin its
 * behaviour directly: course completion with and without `visibleByCourse`,
 * badge derivation, earnedAt stamping, and both certificate rule shapes
 * (track-complete and count-N).
 *
 * Run: node --test server/learning/completion.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    lessonDone,
    courseComplete,
    courseEarnedAt,
    completedCourses,
    computeEarnedBadges,
    certificateEligible,
    certificateProgress,
    certificateCourses,
} = require('./completion');
const { COURSES, getCourse } = require('./courseCatalog');

// Progress helpers — the stored shape is { [lessonId]: { completedAt } }.
const done = (at = '2026-06-01T10:00:00.000Z') => ({ completedAt: at });

function progressFor(lessonIds, at) {
    const map = {};
    lessonIds.forEach((id, i) => { map[id] = done(at || `2026-06-0${(i % 8) + 1}T10:00:00.000Z`); });
    return map;
}

const allLessonIds = COURSES.flatMap((c) => c.lessonIds);

test('lessonDone accepts { completedAt } and legacy true; rejects resume-only entries', () => {
    assert.equal(lessonDone({ a: done() }, 'a'), true);
    assert.equal(lessonDone({ a: true }, 'a'), true);
    assert.equal(lessonDone({ a: { steps: { s1: { status: 'passed' } } } }, 'a'), false);
    assert.equal(lessonDone({}, 'a'), false);
    assert.equal(lessonDone(null, 'a'), false);
});

test('courseComplete requires every lessonId when visibleByCourse is omitted', () => {
    const course = getCourse('course-skills-automation');
    const ids = course.lessonIds;
    assert.equal(courseComplete(course, progressFor(ids.slice(0, -1))), false); // one short
    assert.equal(courseComplete(course, progressFor(ids)), true);
});

test('courseComplete honours visibleByCourse subset (permission-gated lessons excluded)', () => {
    const course = getCourse('course-skills-automation');
    const one = course.lessonIds[0];
    const visible = { 'course-skills-automation': [one] };
    assert.equal(courseComplete(course, progressFor([one]), visible), true);
    // An empty visible set can never complete.
    assert.equal(courseComplete(course, progressFor(allLessonIds), { 'course-skills-automation': [] }), false);
});

// Catalog-driven fixtures: the tests below assert BEHAVIOUR, so they read the
// lesson and course composition out of the catalog instead of pinning it. The
// previous hard-coded lists silently went stale when the 2026-09 curriculum
// grew course-foundations from 2 lessons to 6.
const lessonsOfCourses = (...ids) => ids.flatMap((id) => getCourse(id).lessonIds);
const coursesInTrack = (track) => COURSES.filter((c) => c.track === track).map((c) => c.id);

test('courseComplete is false for unknown course or course with no lessons', () => {
    assert.equal(courseComplete(null, progressFor(allLessonIds)), false);
    assert.equal(courseComplete({ id: 'x', lessonIds: [] }, progressFor(allLessonIds)), false);
});

test('courseEarnedAt is the latest completedAt among required lessons', () => {
    const course = getCourse('course-foundations');
    const ids = course.lessonIds;
    const progress = {};
    ids.forEach((id, i) => { progress[id] = done(`2026-0${(i % 8) + 1}-01T00:00:00.000Z`); });
    progress[ids[ids.length - 1]] = done('2026-11-01T00:00:00.000Z'); // the latest one
    assert.equal(courseEarnedAt(course, progress), '2026-11-01T00:00:00.000Z');
});

test('computeEarnedBadges returns one badge per completed course with earnedAt', () => {
    const progress = progressFor(lessonsOfCourses('course-foundations'));
    const badges = computeEarnedBadges(progress);
    const found = badges.find((b) => b.courseId === 'course-foundations');
    assert.ok(found, 'foundations badge missing');
    assert.equal(found.badgeId, getCourse('course-foundations').badge.id);
    assert.ok(found.earnedAt);
    // Only courses whose lessons are all done earn a badge.
    badges.forEach((b) => assert.ok(getCourse(b.courseId).lessonIds.every((id) => progress[id])));
});

test('track certificate needs every course in the track', () => {
    const track = coursesInTrack('foundations');
    assert.ok(track.length >= 2, 'foundations track should have several courses');
    const partial = progressFor(lessonsOfCourses(track[0]));
    assert.equal(certificateEligible('cert-foundations', partial), false);
    const full = progressFor(lessonsOfCourses(...track));
    assert.equal(certificateEligible('cert-foundations', full), true);
});

test('count certificate needs any N completed courses', () => {
    // Pick courses with no prerequisites so completing them is self-contained.
    const free = COURSES.filter((c) => !(c.prereqCourseIds || []).length).map((c) => c.id);
    const three = progressFor(lessonsOfCourses(...free.slice(0, 3)));
    assert.equal(completedCourses(three).length, 3);
    assert.equal(certificateEligible('cert-practitioner', three), false); // needs 4
    const four = progressFor(lessonsOfCourses(...free.slice(0, 4)));
    assert.equal(completedCourses(four).length, 4);
    assert.equal(certificateEligible('cert-practitioner', four), true);
});

test('certificate eligibility respects visibleByCourse', () => {
    // Three courses finished outright, plus two the learner can only see ONE
    // lesson of: strict counting says 3 of 4, visibility-aware says 5 of 4.
    const free = COURSES.filter((c) => !(c.prereqCourseIds || []).length && c.lessonIds.length > 1).map((c) => c.id);
    const [a, b, c1, d, e] = free;
    const partials = [d, e];
    const visible = {};
    partials.forEach((id) => { visible[id] = [getCourse(id).lessonIds[0]]; });
    const progress = progressFor([
        ...lessonsOfCourses(a, b, c1),
        ...partials.map((id) => getCourse(id).lessonIds[0]),
    ]);
    assert.equal(certificateEligible('cert-practitioner', progress), false);
    assert.equal(certificateEligible('cert-practitioner', progress, visible), true);
});

test('certificateProgress reports { done, total } for both rule shapes', () => {
    const track = coursesInTrack('foundations');
    const progress = progressFor(lessonsOfCourses('course-foundations'));
    assert.deepEqual(certificateProgress('cert-foundations', progress), { done: 1, total: track.length });
    assert.deepEqual(certificateProgress('cert-practitioner', progress), { done: 1, total: 4 });
    assert.deepEqual(certificateProgress('nope', progress), { done: 0, total: 0 });
});

test('certificateCourses snapshots the satisfying courses', () => {
    const track = coursesInTrack('foundations');
    const progress = progressFor(lessonsOfCourses(...track));
    const courses = certificateCourses('cert-foundations', progress);
    assert.deepEqual(courses.map((c) => c.id).sort(), [...track].sort());
});
