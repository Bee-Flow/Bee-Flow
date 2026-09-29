// Academy Custom Courses — org-admin authoring routes (draft CRUD + publish).
//
// Mounted at /ai/learning/admin behind requireCapability('learning_custom_content')
// — see server/routes/ai.js, where this MUST be mounted BEFORE the '/learning'
// router (router.use('/learning') also matches '/learning/admin/*' paths).
//
// Every handler is org-admin gated and scoped to the caller's OWN primary org:
// orgId always comes from req.primaryOrgId (set by requirePrimaryOrgAdmin),
// NEVER from the request body or query.
//
// Everything here operates on DRAFT docs. Members only ever see published
// snapshots (copied by POST /courses/:courseId/publish), and only through the
// sanitized member-facing routes in learning.js — quiz answer keys and
// exercise rubrics returned here never reach non-admins.
//
// What a save may carry is written down below, and it is stricter than the
// store's normaliser on purpose. validateCourseDoc / validateLessonDoc turn
// anything into SOME document — which is right for a store, and was wrong as
// the only gate, because each of these came back as "Saved":
//
//   - a pass score cleared in the editor ('') became 1, so every answer that
//     scored anything passed; a cleared attempt limit became 1 attempt;
//   - `correct: "false"` marked a wrong quiz answer correct (!!'false');
//   - a slide over 8,000 characters lost its tail, an explanation over 400
//     lost its end, with nothing on screen to say so;
//   - `level: 'expert'` became beginner; a lesson id that is not this org's
//     was dropped from the course, orphaning the lesson;
//   - a PUT without lessonIds detached EVERY lesson from the course.
//
// The limits are the store's own (store.LIMITS) — one number, not two copies.
// The editor (pages/settings/learning/admin/AcademyContentEditor.jsx) always
// sends the whole document and shows the server's sentence inline, so a
// refusal here reads as "Step 3: the pass score is a number from 1 to 100."
// rather than a silently different lesson.

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { z } = require('zod');

const { requirePrimaryOrgAdmin } = require('../../auth/permissions');
const store = require('../../stores/learningContentStore');
const { validate } = require('../../core/http/validate');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');

router.use(requireAuth, requirePrimaryOrgAdmin());

// ── What a save may carry ─────────────────────────────────────────────────

const L = store.LIMITS;
const ICON_CHARS = 8;
const ICON_TEXT = 'is one emoji (at most 8 characters).';

/** An absent body is an empty one, so each missing field gets its own sentence rather than "Required". */
const bodyOf = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);

/** "Step 3: " for an issue inside steps[2] — the editor shows only the message, so it has to say where. */
function stepPrefix(path) {
    return path[0] === 'steps' && Number.isInteger(path[1]) ? `Step ${path[1] + 1}: ` : '';
}

/** Every refusal of one step field — wrong type, too long, out of range — as the one sentence that field has. */
const said = (sentence) => ({ errorMap: (issue) => ({ message: stepPrefix(issue.path) + sentence }) });
const stepText = (sentence, max) => z.string(said(sentence)).trim().max(max).optional();
const stepNumber = (sentence, min, max) => z.number(said(sentence)).min(min).max(max).optional();

/** A step object that names the key it does not know, and the step it is in. */
function stepObject(kind, shape) {
    return z.object({ type: z.literal(kind), ...shape }, {
        errorMap: (issue, ctx) => ({
            message: issue.code === z.ZodIssueCode.unrecognized_keys
                ? `${stepPrefix(issue.path)}a ${kind} step has no field ${issue.keys.map((k) => `'${k}'`).join(', ')}.`
                : ctx.defaultError,
        }),
    }).strict();
}

const COMMON_STEP = {
    id: stepText('a step id is text of at most 64 characters.', 64),
    icon: stepText(`the icon ${ICON_TEXT}`, ICON_CHARS),
    title: stepText(`the title is text of at most ${L.maxTitleChars} characters.`, L.maxTitleChars),
};

const Choice = z.object({
    id: stepText('a choice id is text of at most 32 characters.', 32),
    label: stepText(`a choice is text of at most ${L.maxChoiceChars} characters.`, L.maxChoiceChars),
    // The editor's checkbox sends a boolean. `!!` made the STRING "false"
    // mark a wrong answer correct.
    correct: z.boolean(said('a choice is correct (true) or not (false).')).optional(),
}, {
    errorMap: (issue, ctx) => ({
        message: issue.code === z.ZodIssueCode.unrecognized_keys
            ? `${stepPrefix(issue.path)}a choice has only an id, a label and whether it is correct.`
            : stepPrefix(issue.path) + (issue.code === z.ZodIssueCode.invalid_type ? 'a choice is an object with a label.' : ctx.defaultError),
    }),
}).strict();

const Step = z.discriminatedUnion('type', [
    stepObject('slide', {
        ...COMMON_STEP,
        bodyMd: stepText(`the slide text is at most ${L.maxBodyChars} characters.`, L.maxBodyChars),
    }),
    stepObject('quiz', {
        ...COMMON_STEP,
        question: stepText(`the question is text of at most ${L.maxDescChars} characters.`, L.maxDescChars),
        multi: z.boolean(said('whether more than one answer is correct is true or false.')).optional(),
        choices: z.array(Choice, said(`a quiz has a list of at most ${L.maxChoices} choices.`))
            .max(L.maxChoices).optional(),
        explanation: stepText(`the explanation is text of at most ${L.maxDescChars} characters.`, L.maxDescChars),
    }),
    stepObject('exercise', {
        ...COMMON_STEP,
        instruction: stepText(`the instruction is text of at most ${L.maxDescChars} characters.`, L.maxDescChars),
        placeholder: stepText(`the placeholder is text of at most ${L.maxDescChars} characters.`, L.maxDescChars),
        task: stepText(`the task is text of at most ${L.maxDescChars} characters.`, L.maxDescChars),
        // Blank criteria are the editor's empty rows; the store drops them.
        criteria: z.array(z.string(said(`a grading criterion is text of at most ${L.maxCriterionChars} characters.`))
            .trim().max(L.maxCriterionChars), said(`an exercise has a list of at most ${L.maxCriteria} grading criteria.`))
            .max(L.maxCriteria).optional(),
        guidance: stepText(`the grading guidance is text of at most ${L.maxDescChars} characters.`, L.maxDescChars),
        // A cleared number input arrives as ''. `+''` is 0, which the store
        // clamped to 1: a pass score of 1, one attempt — saved.
        passScore: stepNumber('the pass score is a number from 1 to 100.', 1, 100),
        maxAttempts: stepNumber('the number of attempts is a number from 1 to 10.', 1, 10),
    }),
], {
    errorMap: (issue, ctx) => ({
        message: issue.code === z.ZodIssueCode.invalid_union_discriminator || issue.code === z.ZodIssueCode.invalid_type
            ? `${stepPrefix(issue.path)}a step is a slide, a quiz or an exercise.`
            : ctx.defaultError,
    }),
});

/** The whole lesson: a save REPLACES the draft, so a field left out would silently reset. */
const LessonBody = bodyOf(z.object({
    // The URL is authoritative for the id; the editor echoes it back.
    id: z.string({ invalid_type_error: 'A lesson id is text.' }).optional(),
    title: z.string({ required_error: 'Lesson title is required', invalid_type_error: 'A lesson title is text.' })
        .trim().min(1, 'Lesson title is required').max(L.maxTitleChars, `A lesson title is at most ${L.maxTitleChars} characters.`),
    desc: z.string({ required_error: 'A save sends the whole lesson; desc is missing.', invalid_type_error: 'A lesson description is text.' })
        .trim().max(L.maxDescChars, `A lesson description is at most ${L.maxDescChars} characters.`),
    icon: z.string({ required_error: 'A save sends the whole lesson; icon is missing.', invalid_type_error: `A lesson icon ${ICON_TEXT}` })
        .trim().max(ICON_CHARS, `A lesson icon ${ICON_TEXT}`),
    estMinutes: z.number({ required_error: 'A save sends the whole lesson; estMinutes is missing.', invalid_type_error: 'Estimated minutes is a number from 1 to 120.' })
        .min(1, 'Estimated minutes is a number from 1 to 120.').max(120, 'Estimated minutes is a number from 1 to 120.'),
    steps: z.array(Step, { required_error: 'A lesson needs at least one step', invalid_type_error: 'steps is a list of slide, quiz and exercise steps.' })
        .min(1, 'A lesson needs at least one step')
        .max(L.maxStepsPerLesson, `A lesson can have at most ${L.maxStepsPerLesson} steps`),
}).strict());

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const LESSON_ID_TEXT = "lessonIds holds this organisation's lesson ids (orgl-…).";

/**
 * A course. `whole` is the PUT: it replaces the stored draft, so every field
 * is required — a missing `lessonIds` used to detach every lesson. A create
 * may lean on the defaults a new course starts with.
 */
function courseBody(whole) {
    const missing = (key) => `A save sends the whole course; ${key} is missing.`;
    const maybe = (schema) => (whole ? schema : schema.optional());
    return bodyOf(z.object({
        title: z.string({ required_error: 'Course title is required', invalid_type_error: 'A course title is text.' })
            .trim().min(1, 'Course title is required').max(L.maxTitleChars, `A course title is at most ${L.maxTitleChars} characters.`),
        desc: maybe(z.string({ required_error: missing('desc'), invalid_type_error: 'A course description is text.' })
            .trim().max(L.maxDescChars, `A course description is at most ${L.maxDescChars} characters.`)),
        icon: maybe(z.string({ required_error: missing('icon'), invalid_type_error: `A course icon ${ICON_TEXT}` })
            .trim().max(ICON_CHARS, `A course icon ${ICON_TEXT}`)),
        level: maybe(z.enum(LEVELS, {
            errorMap: (issue) => ({
                message: issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined'
                    ? missing('level')
                    : 'A course level is beginner, intermediate or advanced.',
            }),
        })),
        lessonIds: maybe(z.array(z.string({ invalid_type_error: LESSON_ID_TEXT }).refine(store.isOrgLessonId, LESSON_ID_TEXT),
            { required_error: missing('lessonIds'), invalid_type_error: LESSON_ID_TEXT })
            .max(L.maxLessonsPerCourse, `A course can have at most ${L.maxLessonsPerCourse} lessons.`)),
        badgeTitle: maybe(z.string({ required_error: missing('badgeTitle'), invalid_type_error: 'A badge title is text.' })
            .trim().max(L.maxTitleChars, `A badge title is at most ${L.maxTitleChars} characters.`)),
        badgeIcon: maybe(z.string({ required_error: missing('badgeIcon'), invalid_type_error: `A badge icon ${ICON_TEXT}` })
            .trim().max(ICON_CHARS, `A badge icon ${ICON_TEXT}`)),
    }).strict());
}
const NewCourseBody = courseBody(false);
const CourseBody = courseBody(true);

// GET /courses → the org's course index: [{ courseId, title, status, updatedAt }]
router.get('/courses', async (req, res) => {
    try {
        const courses = await store.listCourses(req.primaryOrgId);
        res.json({ courses });
    } catch (e) {
        log.error('[learning/admin] list courses failed:', e.message);
        res.status(500).json({ error: 'Failed to list courses' });
    }
});

// GET /courses/:courseId → draft CourseDoc + the draft LessonDocs it references.
router.get('/courses/:courseId', async (req, res) => {
    try {
        const course = await store.getCourse(req.primaryOrgId, req.params.courseId);
        if (!course) return res.status(404).json({ error: 'Course not found' });
        const lessons = [];
        for (const lessonId of course.lessonIds || []) {
            const lesson = await store.getLesson(req.primaryOrgId, lessonId);
            if (lesson) lessons.push(lesson);
        }
        res.json({ course, lessons });
    } catch (e) {
        log.error('[learning/admin] get course failed:', e.message);
        res.status(500).json({ error: 'Failed to load course' });
    }
});

// POST /courses → create. The id is always minted by the validator (a client
// can never choose its own course id — the schema has no `id` to send).
router.post('/courses', validate({ body: NewCourseBody }), async (req, res) => {
    try {
        const { doc, error } = store.validateCourseDoc({ ...req.body, id: undefined });
        if (error) return res.status(400).json({ error });
        const saved = await store.saveCourse(req.primaryOrgId, doc);
        if (saved.error) return res.status(400).json({ error: saved.error });
        res.json({ course: saved.doc });
    } catch (e) {
        log.error('[learning/admin] create course failed:', e.message);
        res.status(500).json({ error: 'Failed to create course' });
    }
});

// PUT /courses/:courseId → upsert. The URL param is authoritative for the id:
// a valid org course id is the course written, whatever else happens. A
// non-org param (e.g. 'new') makes the validator mint a fresh id — an
// effective create.
router.put('/courses/:courseId', validate({ body: CourseBody }), async (req, res) => {
    try {
        const id = store.isOrgCourseId(req.params.courseId) ? req.params.courseId : undefined;
        const { doc, error } = store.validateCourseDoc({ ...req.body, id });
        if (error) return res.status(400).json({ error });
        const saved = await store.saveCourse(req.primaryOrgId, doc);
        if (saved.error) return res.status(400).json({ error: saved.error });
        res.json({ course: saved.doc });
    } catch (e) {
        log.error('[learning/admin] save course failed:', e.message);
        res.status(500).json({ error: 'Failed to save course' });
    }
});

// DELETE /courses/:courseId → removes the course and ALL its lessons, both
// draft and published snapshots (see learningContentStore.deleteCourse).
router.delete('/courses/:courseId', async (req, res) => {
    try {
        await store.deleteCourse(req.primaryOrgId, req.params.courseId);
        res.json({ success: true });
    } catch (e) {
        log.error('[learning/admin] delete course failed:', e.message);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});

// PUT /lessons/:lessonId → upsert a draft lesson. The URL param is preserved
// when it is a valid org lesson id; anything else (e.g. 'new') makes the
// validator mint a fresh 'orgl-…' id.
//
// IMPORTANT for callers: lessons are stored standalone — saving a NEW lesson
// does NOT attach it to any course. After this returns, the client MUST follow
// up with PUT /courses/:courseId whose body lessonIds includes the returned
// lesson.id (in the desired position), otherwise the lesson is orphaned and
// will never publish.
router.put('/lessons/:lessonId', validate({ body: LessonBody }), async (req, res) => {
    try {
        const id = store.isOrgLessonId(req.params.lessonId) ? req.params.lessonId : undefined;
        const { doc, error } = store.validateLessonDoc({ ...req.body, id });
        if (error) return res.status(400).json({ error });
        const saved = await store.saveLesson(req.primaryOrgId, doc);
        res.json({ lesson: saved.doc });
    } catch (e) {
        log.error('[learning/admin] save lesson failed:', e.message);
        res.status(500).json({ error: 'Failed to save lesson' });
    }
});

// POST /courses/:courseId/publish → copy the draft course + all its lessons to
// the published snapshot keys members read from.
router.post('/courses/:courseId/publish', async (req, res) => {
    try {
        const result = await store.publishCourse(req.primaryOrgId, req.params.courseId);
        if (result.error) return res.status(400).json({ error: result.error });
        res.json({ success: true, course: result.course });
    } catch (e) {
        log.error('[learning/admin] publish failed:', e.message);
        res.status(500).json({ error: 'Failed to publish course' });
    }
});

// POST /courses/:courseId/unpublish → remove the published snapshots; the
// drafts are untouched.
router.post('/courses/:courseId/unpublish', async (req, res) => {
    try {
        await store.unpublishCourse(req.primaryOrgId, req.params.courseId);
        res.json({ success: true });
    } catch (e) {
        log.error('[learning/admin] unpublish failed:', e.message);
        res.status(500).json({ error: 'Failed to unpublish course' });
    }
});

module.exports = router;
