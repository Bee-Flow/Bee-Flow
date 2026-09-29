// Learning Center server routes — AI coach (grade + hint).
//
// Mounted at /ai/learning (see server/routes/ai.js). Authenticated, rate-limited,
// and backed by the server-side rubric catalog so the rubric never reaches the
// client. The grader returns a small structured JSON verdict; a learner is never
// 500'd — on any failure we degrade to a friendly, non-blocking result.
//
// Phase 4 will add achievement + certificate endpoints to this same router.

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const crypto = require('crypto');

const llmClient = require('../../core/llm/llmClient');
const usageStore = require('../../stores/usageStore');
const { resolveModelForTier, resolveModelWithGlobalFallback } = require('../../core/llm/modelResolver');
const configStore = require('../../stores/configStore');
const { getRubric } = require('../../learning/rubrics');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { CERTIFICATES, CATALOG, getCertificate } = require('../../learning/courseCatalog');
const { computeEarnedBadges, certificateEligible, certificateProgress } = require('../../learning/completion');
const { resolveVisibleByCourse } = require('../../learning/visibility');
const { readServerProgress, issueCertificate, buildUrls } = require('../../learning/certificates');
const certStore = require('../../stores/certificateStore');
const { makeVerifyToken, hasDurableSecret } = require('../../auth/certificateToken');
const { renderCertificatePng, renderCertificatePdf } = require('../../services/certificateRenderer');
const userStore = require('../../stores/userStore');
const { requirePrimaryOrgAdmin } = require('../../auth/permissions');
const { getOrgOverview } = require('../../learning/orgOverview');
const { validate } = require('../../core/http/validate');
const { z, worded, bodyOf } = require('../../core/http/schemaParts');

// ── What a learner's request may carry ───────────────────────────────
// Closed bodies. What they close: `makePublic: "false"` issued a PUBLIC
// certificate, with a verify link that shows the learner's name and
// organisation to anyone holding it (only the boolean false counted); a
// misspelled `mode` on the coach ran the hint path instead of grading.
// `locale` stays loose text: the handlers already fall back to English for
// anything that is not a plain language tag, and a learner must not be
// refused over their browser's spelling of it.
const lText = (name, max) => worded(`${name} is text.`).max(max, `${name} is at most ${max} characters.`);
const modelTier = lText('modelTier', 100).optional();
const locale = lText('locale', 40).optional();
const choiceIds = z.array(z.union([z.string(), z.number()]), { invalid_type_error: 'choiceIds is a list of answer ids.' }).optional();
const CoachBody = bodyOf({
    exerciseId: lText('exerciseId', 300).optional(),
    mode: z.enum(['grade', 'hint'], { errorMap: () => ({ message: 'mode is grade or hint.' }) }).optional(),
    submission: lText('submission', 200_000).optional(),
    modelTier, locale,
}, 'A coach request');
const TutorBody = bodyOf({
    question: lText('question', 50_000).optional(),
    lessonId: lText('lessonId', 300).optional(),
    stepId: lText('stepId', 300).optional(),
    stepContext: lText('stepContext', 200_000).optional(),
    modelTier, locale,
}, 'A tutor question');
const PracticeBody = bodyOf({
    lessonIds: z.array(z.union([z.string(), z.number()]), { invalid_type_error: 'lessonIds is a list of lesson ids.' }).optional(),
    count: z.union([z.number(), z.string()], { invalid_type_error: 'count is a number.' }).optional(),
    modelTier, locale,
}, 'A practice set');
const PracticeGradeBody = bodyOf({
    practiceId: lText('practiceId', 300).optional(),
    itemId: lText('itemId', 300).optional(),
    choiceIds,
}, 'A practice answer');
const QuizGradeBody = bodyOf({
    lessonId: lText('lessonId', 300).optional(),
    stepId: lText('stepId', 300).optional(),
    choiceIds,
}, 'A quiz answer');
const CertificateBody = bodyOf({
    certificateId: lText('certificateId', 300).optional(),
    makePublic: z.boolean({ invalid_type_error: 'makePublic is true or false.' }).optional(),
}, 'A certificate request');
const TrainingRulesBody = bodyOf({
    areas: z.record(z.unknown(), { required_error: 'areas must be an object of { areaId: courseId }', invalid_type_error: 'areas must be an object of { areaId: courseId }' }),
}, 'The training rules');
const { hasCapability } = require('../../core/entitlements/entitlements');
const learningContentStore = require('../../stores/learningContentStore');
const { COURSES } = require('../../learning/courseCatalog');
const {
    TRAINING_AREAS,
    getSettings: getTrainingSettings,
    setSettings: setTrainingSettings,
} = require('../../learning/trainingGates');
const { evaluateForRequest } = require('../../learning/requireTraining');

// Published org-authored courses for the caller, as completion.js extraCourses
// + catalog-overlay entries. Empty unless the org has the custom-content beta.
async function orgCoursesFor(req) {
    const userId = req.session.user.id;
    const orgId = req.session.user.organizationId || null;
    if (!orgId) return [];
    try {
        const entitled = await hasCapability('learning_custom_content', { userId, orgId, session: req.session, req });
        if (!entitled) return [];
        return await learningContentStore.getPublishedCourses(orgId);
    } catch (_) {
        return [];
    }
}

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');

// LLM-backed and per-user — generous enough for an honest learner retrying an
// exercise, tight enough that the endpoint can't be turned into a free LLM.
const coachLimiter = perUserRateLimit({ windowMs: 60_000, max: 20 });

// 'thinking' is deliberately excluded: a 600-token rubric grade never needs an
// expensive reasoning model (the client only ever sends 'fast' today).
const ALLOWED_TIERS = new Set(['fast', 'standard', 'auto']);
const MAX_SUBMISSION_CHARS = 4000;

// Identical resubmissions (double-click, impatient retry) return the cached
// verdict without a second LLM call. Small in-memory LRU, same in-process style
// as perUserRateLimit — per-replica is fine, this is a cost guard not a lock.
const VERDICT_CACHE_TTL_MS = 10 * 60 * 1000;
const VERDICT_CACHE_MAX = 500;
const verdictCache = new Map();

function verdictCacheKey(userId, exerciseId, mode, submission) {
    return crypto.createHash('sha256').update(`${userId}|${exerciseId}|${mode}|${submission}`).digest('hex');
}

function verdictCacheGet(key) {
    const hit = verdictCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > VERDICT_CACHE_TTL_MS) { verdictCache.delete(key); return null; }
    return hit.value;
}

function verdictCacheSet(key, value) {
    if (verdictCache.size >= VERDICT_CACHE_MAX) {
        const oldest = verdictCache.keys().next().value;
        if (oldest !== undefined) verdictCache.delete(oldest);
    }
    verdictCache.set(key, { value, ts: Date.now() });
}

// Coach calls are real LLM spend — log them to the monitoring store like every
// other AI route (pattern: directChat). Best-effort, never blocks the learner.
async function logCoachUsage({ userId, userOrgId, modelId, usage, startMs, source = 'learning_coach' }) {
    try {
        await usageStore.logUsage({
            user_id: userId,
            agent_name: source === 'learning_practice' ? 'learning-practice' : 'learning-coach',
            agent_type: 'system',
            model: modelId,
            prompt_tokens: usage?.prompt_tokens || 0,
            completion_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0)),
            cached_tokens: usage?.cached_tokens || 0,
            cache_creation_tokens: usage?.cache_creation_tokens || 0,
            source,
            duration_ms: Date.now() - startMs,
            organization_id: userOrgId || null,
        });
    } catch (e) {
        log.warn('[learning/coach] failed to log usage:', e.message);
    }
}

// Resolve a concrete model id for the requested tier, falling back to the global
// default so a missing tier config never breaks grading.
async function resolveModel(modelTier, { userId, userOrgId }) {
    const tier = ALLOWED_TIERS.has(modelTier) ? modelTier : 'fast';
    try {
        const resolved = await resolveModelForTier(`tier:${tier}`, { userOrgId, userId, fallbackTier: 'fast' });
        if (resolved) return resolved;
    } catch (_) { /* fall through */ }
    return resolveModelWithGlobalFallback(`tier:${tier}`, { userOrgId, userId });
}

// Server-owned ledger of exercise attempts/passes, written ONLY by this route
// after a real grading call. Not yet enforced for certificate issuance (the
// exercise is a soft gate the client may skip after maxAttempts) — but the
// server-stamped firstSeenAt provides grandfathering data if enforcement is
// turned on later. Advisory: a write failure never blocks the learner.
async function recordExerciseAttempt(userId, exerciseId, passed, score) {
    try {
        const key = `learning_exercises_user_${userId}`;
        const ledger = (await configStore.getConfig(key)) || {};
        const prev = (ledger[exerciseId] && typeof ledger[exerciseId] === 'object') ? ledger[exerciseId] : {};
        const now = new Date().toISOString();
        ledger[exerciseId] = {
            attempts: (prev.attempts || 0) + 1,
            passed: !!(prev.passed || passed),
            bestScore: Math.max(prev.bestScore || 0, typeof score === 'number' ? score : 0),
            firstSeenAt: prev.firstSeenAt || now,
            firstPassedAt: prev.firstPassedAt || (passed ? now : null),
        };
        await configStore.setConfig(key, ledger);
    } catch (e) {
        log.warn('[learning/coach] exercise ledger write failed:', e.message);
    }
}

// Tolerant JSON extraction — models sometimes wrap JSON in prose or code fences.
function parseJsonLoose(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch (_) { /* try to extract */ }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
        try { return JSON.parse(text.slice(first, last + 1)); } catch (_) { /* give up */ }
    }
    return null;
}

const TUTOR_SYSTEM = [
    'You are the friendly AI coach inside Bee Flow\'s Learning Center. A learner is mid-lesson and asks you a question in their own words.',
    'Answer from the PRODUCT FACTS below plus the lesson-step context the learner\'s app sends along. The product facts are authoritative; the step context only tells you what the learner is looking at.',
    'Coach, don\'t lecture: 2-5 short sentences (or a tight bullet list), concrete, in plain language. When the question is about a graded exercise, nudge toward the answer with a hint or an example of the KIND of thing that works — never write their answer for them.',
    'If the question is unrelated to Bee Flow or the lesson, gently steer back in one sentence.',
    'You may use light markdown (bold, bullets). Do not invent product features that are not in the facts.',
    'Respond with ONLY a JSON object: {"answer": "<your reply>"}',
].join('\n');

const GRADER_SYSTEM = [
    'You are a warm, encouraging but honest tutor inside Bee Flow, grading hands-on exercises (prompt writing, automation design, admin practices, and similar).',
    'You grade a learner\'s attempt against a private rubric.',
    'Be specific and constructive: point to what they did well and exactly what would make their answer stronger.',
    'Rules:',
    '- NEVER reveal or quote the rubric verbatim, and never write the full ideal answer for them.',
    '- Judge ONLY the submission against the criteria. Do not reward length or buzzwords.',
    '- If the submission is empty, off-topic, or clearly not a genuine attempt, score it low and say so kindly.',
    '- Keep feedback to 2–4 short sentences. Keep each strength/improvement under ~12 words.',
    'Respond with ONLY a JSON object, no prose, no code fences, of exactly this shape:',
    '{"score": <integer 0-100>, "feedback": "<short paragraph>", "strengths": ["..."], "improvements": ["..."]}',
].join('\n');

const HINT_SYSTEM = [
    'You are a helpful tutor inside Bee Flow guiding a learner through a hands-on exercise.',
    'Give ONE short, specific hint that nudges the learner toward a stronger answer for the exercise.',
    'Do NOT write the answer for them — point at the kind of thing they are missing.',
    'Respond with ONLY a JSON object: {"hint": "<one sentence>"}',
].join('\n');

router.post('/coach', requireAuth, coachLimiter, validate({ body: CoachBody }), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = req.session.user.organizationId || null;
    const { exerciseId, mode = 'grade', modelTier = 'fast' } = req.body || {};
    let submission = typeof req.body?.submission === 'string' ? req.body.submission : '';
    // The learner's UI locale — the coach replies in their language. Shape-
    // checked so it can only ever be a language tag, never prompt injection.
    const locale = /^[a-z]{2}(-[A-Z]{2})?$/.test(String(req.body?.locale || '')) ? req.body.locale : 'en';
    const localeNote = locale === 'en' ? '' : `\nWrite the feedback in the learner's language: ${locale}. Keep the JSON keys in English.`;

    // Built-in rubrics first; then org-authored exercise rubrics (resolved from
    // the PUBLISHED lesson snapshot by `${lessonId}:${stepId}`, never drafts).
    let rubric = getRubric(exerciseId);
    if (!rubric && userOrgId) {
        try { rubric = await learningContentStore.findRubric(userOrgId, exerciseId); } catch (_) { /* 404 below */ }
    }
    if (!rubric) return res.status(404).json({ error: 'Unknown exercise' });

    submission = submission.slice(0, MAX_SUBMISSION_CHARS).trim();

    // No-attempt fast path — don't spend an LLM call on an empty box.
    if (mode === 'grade' && submission.length < 3) {
        return res.json({
            score: 0, passed: false,
            feedback: 'Give it a try first — write your prompt in the box and submit it for review.',
            strengths: [], improvements: [],
        });
    }

    // Identical resubmission → cached verdict, no LLM spend. Locale is part of
    // the key so switching UI language doesn't serve a stale-language verdict.
    const cacheKey = verdictCacheKey(userId, exerciseId, `${mode}|${locale}`, submission);
    const cached = verdictCacheGet(cacheKey);
    if (cached) return res.json(cached);

    let modelId;
    try {
        modelId = await resolveModel(modelTier, { userId, userOrgId });
    } catch (_) { modelId = null; }
    if (!modelId) {
        return res.json(mode === 'hint'
            ? { hint: 'Try naming who the prompt is for and the exact format you want back.', error: 'coach_unavailable' }
            : { score: null, passed: false, feedback: 'The AI coach is unavailable right now — you can retry or skip ahead.', strengths: [], improvements: [], error: 'coach_unavailable' });
    }

    const startMs = Date.now();
    try {
        if (mode === 'hint') {
            const messages = [
                { role: 'system', content: HINT_SYSTEM + (localeNote ? localeNote.replace('feedback', 'hint') : '') },
                { role: 'user', content: `Exercise task: ${rubric.task}\n\nThe learner has written so far:\n"""\n${submission || '(nothing yet)'}\n"""\n\nWhat they should aim for (do not reveal this verbatim): ${rubric.criteria.join('; ')}.` },
            ];
            const result = await llmClient.chat(modelId, messages, {
                maxTokens: 200, temperature: 0.5,
                extraBody: { response_format: { type: 'json_object' } },
            });
            await logCoachUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs });
            const parsed = parseJsonLoose(result?.content) || {};
            const hintBody = { hint: typeof parsed.hint === 'string' && parsed.hint.trim() ? parsed.hint.trim() : 'Add concrete context (who it\'s for, the goal) and pin down the output format.' };
            verdictCacheSet(cacheKey, hintBody);
            return res.json(hintBody);
        }

        // mode === 'grade'
        const userMsg = [
            `Exercise task: ${rubric.task}`,
            '',
            `Grade against these criteria (a strong answer shows all of them):`,
            ...rubric.criteria.map((c, i) => `${i + 1}. ${c}`),
            '',
            `Grading guidance: ${rubric.guidance}`,
            '',
            `The learner submitted:`,
            '"""',
            submission,
            '"""',
            '',
            'Return the JSON verdict now.',
        ].join('\n');

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: GRADER_SYSTEM + localeNote },
            { role: 'user', content: userMsg },
        ], {
            maxTokens: 600, temperature: 0.2,
            extraBody: { response_format: { type: 'json_object' } },
        });
        await logCoachUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs });

        const parsed = parseJsonLoose(result?.content);
        if (!parsed || typeof parsed.score !== 'number') {
            return res.json({ score: null, passed: false, feedback: 'We couldn\'t grade that automatically — give it another go, or skip ahead.', strengths: [], improvements: [], error: 'grade_unavailable' });
        }

        const passScore = typeof rubric.passScore === 'number' ? rubric.passScore : 70;
        const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
        const clean = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 4) : []);
        await recordExerciseAttempt(userId, exerciseId, score >= passScore, score);
        const verdict = {
            score,
            passed: score >= passScore,
            feedback: typeof parsed.feedback === 'string' ? parsed.feedback.trim().slice(0, 800) : '',
            strengths: clean(parsed.strengths),
            improvements: clean(parsed.improvements),
        };
        verdictCacheSet(cacheKey, verdict);
        return res.json(verdict);
    } catch (e) {
        log.error('[learning/coach] grading failed:', e.message);
        return res.json({ score: null, passed: false, feedback: 'The AI coach hit a snag — you can retry or skip ahead.', strengths: [], improvements: [], error: 'coach_error' });
    }
});

// ── Lesson tutor ("Ask AI" on every player step) ─────────────────────────────
//
// Free-form help mid-lesson, grounded in the server-owned product fact sheet
// (learning/productGuide.js) — the client's stepContext only says what the
// learner is looking at, never what is true about the product. Same guard
// rails as the coach: per-user rate limit, size caps, cached identical asks,
// usage logged, and a learner is never 500'd.
const { PRODUCT_GUIDE } = require('../../learning/productGuide');
const MAX_QUESTION_CHARS = 1000;
const MAX_STEP_CONTEXT_CHARS = 2000;
const TUTOR_FALLBACK_ANSWER = 'The AI coach is unavailable right now — try again in a moment, or keep going with the lesson.';

router.post('/tutor', requireAuth, coachLimiter, validate({ body: TutorBody }), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = req.session.user.organizationId || null;
    const { lessonId = '', stepId = '', modelTier = 'fast' } = req.body || {};
    const question = String(req.body?.question || '').slice(0, MAX_QUESTION_CHARS).trim();
    const stepContext = String(req.body?.stepContext || '').slice(0, MAX_STEP_CONTEXT_CHARS).trim();
    const locale = /^[a-z]{2}(-[A-Z]{2})?$/.test(String(req.body?.locale || '')) ? req.body.locale : 'en';
    const localeNote = locale === 'en' ? '' : `\nAnswer in the learner's language: ${locale}. Keep the JSON key in English.`;

    if (question.length < 2) {
        return res.json({ answer: 'Ask me anything about this step — what it means, why it matters, or how to do it in Bee Flow.' });
    }

    const cacheKey = verdictCacheKey(userId, `tutor:${lessonId}:${stepId}`, locale, question);
    const cached = verdictCacheGet(cacheKey);
    if (cached) return res.json(cached);

    let modelId;
    try {
        modelId = await resolveModel(modelTier, { userId, userOrgId });
    } catch (_) { modelId = null; }
    if (!modelId) return res.json({ answer: TUTOR_FALLBACK_ANSWER, error: 'tutor_unavailable' });

    const startMs = Date.now();
    try {
        const userMsg = [
            'PRODUCT FACTS:',
            PRODUCT_GUIDE,
            '',
            stepContext ? `LESSON STEP THE LEARNER IS LOOKING AT (lesson "${String(lessonId).slice(0, 64)}"):\n${stepContext}` : `LESSON: "${String(lessonId).slice(0, 64)}" (no step context sent).`,
            '',
            `THE LEARNER ASKS:\n"""\n${question}\n"""`,
            '',
            'Reply with the JSON now.',
        ].join('\n');

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: TUTOR_SYSTEM + localeNote },
            { role: 'user', content: userMsg },
        ], {
            maxTokens: 500, temperature: 0.4,
            extraBody: { response_format: { type: 'json_object' } },
        });
        await logCoachUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs });

        const parsed = parseJsonLoose(result?.content);
        const answer = typeof parsed?.answer === 'string' && parsed.answer.trim()
            ? parsed.answer.trim().slice(0, 2000)
            : TUTOR_FALLBACK_ANSWER;
        const body = { answer };
        verdictCacheSet(cacheKey, body);
        return res.json(body);
    } catch (e) {
        log.error('[learning/tutor] failed:', e.message);
        return res.json({ answer: TUTOR_FALLBACK_ANSWER, error: 'tutor_error' });
    }
});

// ── AI practice generator (v2 review layer) ──────────────────────────────────
//
// Fresh multiple-choice items so practice is never the same twice. Generation
// is grounded ONLY in the server-owned topic registry (learning/practiceTopics)
// — the client contributes nothing but whitelisted lesson ids and a locale tag,
// so a learner can't steer the prompt. Output comes through ONE forced tool
// call (response_format is a no-op across adapters — see core/llm/llmClient)
// and is re-validated/clamped by learning/practiceValidation before an answer
// key is minted. Keys live server-side in a short-TTL LRU under a practiceId;
// the client only ever sees question + choices, and grading mirrors
// /quiz/grade. Everything degrades: any failure returns practice_unavailable
// and the client falls back to bundled quiz items.
const { getPracticeTopic } = require('../../learning/practiceTopics');
const { PRACTICE_TOOL, validatePracticeItems, publicPracticeItem, MAX_ITEMS } = require('../../learning/practiceValidation');

const PRACTICE_TTL_MS = 24 * 60 * 60 * 1000;
const PRACTICE_KEY_CACHE_MAX = 300;
// practiceId → { keys: { [itemId]: { correctChoiceIds, explanation } }, ts }
//
// PER-POD, AND THAT IS ONLY HALF THE STORY. Generate and grade are two separate
// requests with nothing pinning them to the same replica — prod runs the server
// Deployment behind an ingress with no session affinity and an HPA on top. So a
// learner generates on pod A, answers, and grades on pod B, whose Map has never
// heard of that practiceId: a 404 practice_expired on the first question of
// every other session. It works perfectly at one replica, which is why dev
// never showed it.
//
// The Map stays as the fast path. The durable copy goes in configStore under
// PRACTICE_KEY_PREFIX so any pod can grade, and the security property is
// unchanged: the key is written and read server-side only, the client still
// receives question + choices and never a correctChoiceIds.
const practiceKeyCache = new Map();
const PRACTICE_KEY_PREFIX = 'learning_practice_keys_';
// topic-set → { payload, ts } — shared across users per replica; THE cost bound.
const practiceTopicCache = new Map();
const PRACTICE_TOPIC_CACHE_MAX = 100;

function practiceCachePrune(map, max) {
    const now = Date.now();
    for (const [k, v] of map) { if (now - v.ts > PRACTICE_TTL_MS) map.delete(k); }
    while (map.size >= max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

const PRACTICE_SYSTEM = [
    'You write short multiple-choice practice questions for Bee Flow\'s Learning Center.',
    'Ground every question ONLY in the topic facts provided — never invent product behaviour.',
    'Rules:',
    '- One clear question per item; 3-4 plausible choices; EXACTLY one correct.',
    '- Wrong choices must be believable misconceptions, not jokes or throwaways.',
    '- Vary the angle: apply-the-concept scenarios beat definition recall.',
    '- The explanation teaches WHY the correct answer is right, in one or two sentences.',
    '- Never reuse the topic facts verbatim as a question or a choice.',
].join('\n');

const practiceGenerateLimiter = perUserRateLimit({ windowMs: 60 * 60_000, max: 10 });
const practiceGradeLimiter = perUserRateLimit({ windowMs: 60_000, max: 60 });

router.post('/practice/generate', requireAuth, practiceGenerateLimiter, validate({ body: PracticeBody }), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = req.session.user.organizationId || null;
    const unavailable = () => res.json({ error: 'practice_unavailable', items: [] });

    const requested = Array.isArray(req.body?.lessonIds) ? req.body.lessonIds.map(String).slice(0, 12) : [];
    const lessonIds = [...new Set(requested.filter((id) => !!getPracticeTopic(id)))];
    if (!lessonIds.length) return res.status(400).json({ error: 'unknown_lessons', items: [] });
    const count = Math.max(1, Math.min(MAX_ITEMS, Number(req.body?.count) || 3));
    const locale = /^[a-z]{2}(-[A-Z]{2})?$/.test(String(req.body?.locale || '')) ? req.body.locale : 'en';

    // Same topic set + count + locale within the TTL → the same set, no LLM
    // spend. The matching answer keys were minted alongside the payload.
    const topicKey = `${[...lessonIds].sort().join(',')}|${count}|${locale}`;
    const cachedTopic = practiceTopicCache.get(topicKey);
    if (cachedTopic && Date.now() - cachedTopic.ts < PRACTICE_TTL_MS && practiceKeyCache.has(cachedTopic.payload.practiceId)) {
        return res.json(cachedTopic.payload);
    }

    let modelId;
    try {
        modelId = await resolveModel(req.body?.modelTier || 'fast', { userId, userOrgId });
    } catch (_) { modelId = null; }
    if (!modelId) return unavailable();

    const startMs = Date.now();
    try {
        const topicBlock = lessonIds.map((id) => {
            const topic = getPracticeTopic(id);
            return `TOPIC "${id}" — ${topic.title}\n${topic.summary}\nFacts:\n${topic.facts.map((f) => `- ${f}`).join('\n')}`;
        }).join('\n\n');
        const localeNote = locale === 'en' ? '' : `\nWrite the questions, choices and explanations in the learner's language: ${locale}.`;
        const userMsg = [
            topicBlock,
            '',
            `Write ${count} practice question(s) covering these topics (spread across them when there is more than one).${localeNote}`,
            'Submit them with the submit_practice_items tool.',
        ].join('\n');

        const result = await llmClient.chatForcedTool(modelId, [
            { role: 'system', content: PRACTICE_SYSTEM },
            { role: 'user', content: userMsg },
        ], PRACTICE_TOOL, { maxTokens: 1600, temperature: 0.7 });
        await logCoachUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs, source: 'learning_practice' });

        const items = validatePracticeItems(result?.structured, lessonIds);
        if (!items) return unavailable();

        const practiceId = crypto.randomUUID();
        const keys = {};
        const publicItems = items.map((item, i) => {
            const id = `p${i + 1}`;
            keys[id] = {
                correctChoiceIds: item.choices.filter((c) => c.correct).map((c) => c.id),
                explanation: item.explanation,
            };
            return publicPracticeItem(item, id);
        });

        practiceCachePrune(practiceKeyCache, PRACTICE_KEY_CACHE_MAX);
        practiceKeyCache.set(practiceId, { keys, ts: Date.now() });
        // Durable copy for whichever pod the grade request lands on. Best
        // effort on purpose: if the write fails the session still works on this
        // pod, which is strictly better than failing generation outright.
        try {
            await require('../../stores/configStore')
                .setConfig(`${PRACTICE_KEY_PREFIX}${practiceId}`, { keys, ts: Date.now() });
        } catch (err) {
            log.warn('[learning/practice] key persist failed (single-pod grading only):', err.message);
        }
        const payload = { practiceId, items: publicItems, expiresAt: new Date(Date.now() + PRACTICE_TTL_MS).toISOString() };
        practiceCachePrune(practiceTopicCache, PRACTICE_TOPIC_CACHE_MAX);
        practiceTopicCache.set(topicKey, { payload, ts: Date.now() });
        return res.json(payload);
    } catch (e) {
        log.error('[learning/practice] generation failed:', e.message);
        return unavailable();
    }
});

// Grade one practice answer against the server-held key. Mirrors /quiz/grade:
// correct ids are revealed only on a pass; an expired/unknown practiceId is a
// retriable 404 (the client offers a fresh session instead of blocking).
router.post('/practice/grade', requireAuth, practiceGradeLimiter, validate({ body: PracticeGradeBody }), async (req, res) => {
    const { practiceId, itemId } = req.body || {};
    const choiceIds = Array.isArray(req.body?.choiceIds) ? req.body.choiceIds.map(String).slice(0, 8) : [];
    let entry = typeof practiceId === 'string' ? practiceKeyCache.get(practiceId) : null;
    if (!entry && typeof practiceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(practiceId)) {
        // Generated on another pod. Read the durable copy and warm this pod's
        // Map so the rest of the session grades locally.
        try {
            const stored = await require('../../stores/configStore').getConfig(`${PRACTICE_KEY_PREFIX}${practiceId}`);
            if (stored && stored.keys) {
                entry = { keys: stored.keys, ts: Number(stored.ts) || 0 };
                practiceCachePrune(practiceKeyCache, PRACTICE_KEY_CACHE_MAX);
                practiceKeyCache.set(practiceId, entry);
            }
        } catch (err) {
            log.warn('[learning/practice] key lookup failed:', err.message);
        }
    }
    if (!entry || Date.now() - entry.ts > PRACTICE_TTL_MS) {
        return res.status(404).json({ error: 'practice_expired' });
    }
    const key = entry.keys[String(itemId)];
    if (!key) return res.status(404).json({ error: 'practice_expired' });
    const picked = new Set(choiceIds);
    const correct = key.correctChoiceIds.length === picked.size && key.correctChoiceIds.every((id) => picked.has(id));
    res.json({
        correct,
        explanation: key.explanation,
        ...(correct ? { correctChoiceIds: key.correctChoiceIds } : {}),
    });
});

// ── Catalog ───────────────────────────────────────────────────────────────────

// The structural course catalog (course ids, lessonIds, tracks, prereqs, badges,
// certificate rules, lesson gates). The client overlays this onto its bundled
// presentation copy at load, so structure changes ship without a frontend
// release and the two copies can't silently drift. When the org has the
// custom-content beta, published org courses are appended with their lesson
// docs inline — sanitized so quiz answers and rubrics never leave the server.
router.get('/catalog', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'private, max-age=300');
    const published = await orgCoursesFor(req);
    if (!published.length) return res.json(CATALOG);
    const orgCourses = published.map(({ course, lessons }) => ({
        id: course.id,
        title: course.title,
        desc: course.desc,
        icon: course.icon,
        level: course.level,
        track: null,
        lessonIds: course.lessonIds,
        prereqCourseIds: [],
        badge: course.badge,
        source: 'org',
        lessons: lessons.map((l) => learningContentStore.publicLessonView(l)),
    }));
    res.json({ ...CATALOG, courses: [...CATALOG.courses, ...orgCourses] });
});

// ── Server-graded quizzes (org-authored lessons) ──────────────────────────────

// Org quiz answer keys never ship to the client (publicLessonView strips
// `correct` and marks the step serverGraded). The player submits choices here;
// we grade against the PUBLISHED lesson snapshot. correctChoiceIds is revealed
// only on a correct answer so the UI can highlight it — wrong answers just get
// retried, mirroring the built-in client-side quiz behaviour.
const quizLimiter = perUserRateLimit({ windowMs: 60_000, max: 60 });

router.post('/quiz/grade', requireAuth, quizLimiter, validate({ body: QuizGradeBody }), async (req, res) => {
    const userOrgId = req.session.user.organizationId || null;
    const { lessonId, stepId } = req.body || {};
    const choiceIds = Array.isArray(req.body?.choiceIds) ? req.body.choiceIds.map(String).slice(0, 12) : [];
    if (!learningContentStore.isOrgLessonId(lessonId) || !stepId) {
        return res.status(404).json({ error: 'Unknown quiz' });
    }
    try {
        const lesson = userOrgId ? await learningContentStore.getLesson(userOrgId, lessonId, { published: true }) : null;
        const step = (lesson?.steps || []).find((s) => s.type === 'quiz' && s.id === stepId);
        if (!step) return res.status(404).json({ error: 'Unknown quiz' });
        const correctIds = (step.choices || []).filter((c) => c.correct).map((c) => c.id);
        const picked = new Set(choiceIds);
        const correct = correctIds.length === picked.size && correctIds.every((id) => picked.has(id));
        res.json({
            correct,
            explanation: step.explanationFallback || '',
            ...(correct ? { correctChoiceIds: correctIds } : {}),
        });
    } catch (e) {
        log.error('[learning/quiz] grade failed:', e.message);
        res.status(500).json({ error: 'Failed to grade quiz' });
    }
});

// ── Achievements + certificates ───────────────────────────────────────────────

function recipientName(user) {
    if (user?.displayName) return user.displayName;
    const full = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
    return full || user?.username || 'Bee Flow learner';
}

async function orgName(user) {
    try {
        if (!user?.organizationId) return null;
        const org = await userStore.getOrganization(user.organizationId);
        return org?.name || null;
    } catch (_) { return null; }
}

// What the learner has earned + how close they are to each certificate. Badges and
// eligibility are recomputed server-side from the progress blob (never trusted from
// the client), against the lessons this user can actually access (visibleByCourse)
// so a permission-gated lesson never blocks a course the UI shows as complete.
// verifyToken/serial are returned only for the owner's own certs.
router.get('/achievements', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = req.session.user.organizationId || null;
    try {
        const [progress, { visibleByCourse }, orgPublished] = await Promise.all([
            readServerProgress(userId),
            resolveVisibleByCourse({ userId, orgId: userOrgId, session: req.session, req }),
            orgCoursesFor(req),
        ]);
        // Org courses earn badges like built-ins; they never count toward
        // certificates (see completion.js certificateEligible note).
        const extraCourses = orgPublished.map(({ course }) => ({
            id: course.id, lessonIds: course.lessonIds, badge: course.badge,
        }));
        const badges = computeEarnedBadges(progress, visibleByCourse, '2026.1', extraCourses);

        const certificates = [];
        for (const cert of CERTIFICATES) {
            const eligible = certificateEligible(cert.id, progress, visibleByCourse);
            const prog = certificateProgress(cert.id, progress, visibleByCourse);
            const issued = await certStore.getCertificate(userId, cert.id);
            const entry = {
                certificateId: cert.id,
                title: cert.title,
                level: cert.level || null,
                eligible,
                issued: !!issued,
                isPublic: !!issued?.isPublic,
                progress: prog,
            };
            if (issued) {
                const verifyToken = makeVerifyToken(cert.id, userId);
                Object.assign(entry, buildUrls(issued, verifyToken), { issuedAt: issued.issuedAt });
            }
            certificates.push(entry);
        }
        res.json({ badges, certificates, version: '2026.1' });
    } catch (e) {
        log.error('[learning/achievements] failed:', e.message);
        res.status(500).json({ error: 'Failed to load achievements' });
    }
});

// Issue (or update visibility of) a certificate. Server recomputes eligibility.
router.post('/certificate', requireAuth, validate({ body: CertificateBody }), async (req, res) => {
    const user = req.session.user;
    const { certificateId, makePublic = false } = req.body || {};
    if (!getCertificate(certificateId)) return res.status(404).json({ error: 'Unknown certificate' });
    // Public verify links are HMAC-derived; without a restart-stable secret they
    // would silently break on the next deploy. Private issuance still works.
    if (makePublic && !hasDurableSecret()) {
        return res.status(400).json({ error: 'public_verify_unavailable' });
    }
    try {
        const { visibleByCourse } = await resolveVisibleByCourse({
            userId: user.id, orgId: user.organizationId || null, session: req.session, req,
        });
        const result = await issueCertificate(user.id, certificateId, {
            recipientName: recipientName(user),
            orgName: await orgName(user),
            makePublic: !!makePublic,
            visibleByCourse,
        });
        if (result.error === 'not_eligible') return res.status(403).json({ error: 'Not eligible yet — complete the required courses first.' });
        if (result.error) return res.status(400).json({ error: result.error });

        const { record, verifyToken } = result;
        const urls = buildUrls(record, verifyToken);
        res.json({
            certificateId: record.certificateId,
            title: record.title,
            level: record.level,
            serial: record.serial,
            issuedAt: record.issuedAt,
            isPublic: record.isPublic,
            recipientName: record.recipientName,
            orgName: record.orgName,
            courses: record.courses,
            ...urls,
        });
    } catch (e) {
        log.error('[learning/certificate] issue failed:', e.message);
        res.status(500).json({ error: 'Failed to issue certificate' });
    }
});

// Owner-only render of their own certificate (private or public) for in-app preview
// and download. The public, token-gated render lives in routes/verifyCertificate.js.
async function ownerRender(req, res, kind) {
    const userId = req.session.user.id;
    const certId = req.params.certId;
    const record = await certStore.getCertificate(userId, certId);
    if (!record) return res.status(404).json({ error: 'Certificate not issued' });
    const verifyToken = makeVerifyToken(certId, userId);
    const { verifyUrl } = buildUrls(record, verifyToken);
    try {
        if (kind === 'pdf') {
            const pdf = await renderCertificatePdf(record, { verifyUrl });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="beeflow-certificate-${record.serial}.pdf"`);
            return res.send(pdf);
        }
        const png = await renderCertificatePng(record, { verifyUrl });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.send(png);
    } catch (e) {
        log.error('[learning/certificate render] failed:', e.message);
        return res.status(500).json({ error: 'Failed to render certificate' });
    }
}

router.get('/certificate/:certId/image.png', requireAuth, (req, res) => ownerRender(req, res, 'png'));
router.get('/certificate/:certId/certificate.pdf', requireAuth, (req, res) => ownerRender(req, res, 'pdf'));

// ── Org learning overview (admin) ─────────────────────────────────────────────

// Per-member completion summary for the caller's OWN org — courses done,
// badges, certificates (ids/levels/dates only, never serials or tokens),
// last activity. Org-admin gated; 60s-cached aggregation over two batched
// configStore reads, so safe to refresh freely from the panel.
router.get('/org-overview', requireAuth, requirePrimaryOrgAdmin(), async (req, res) => {
    try {
        const overview = await getOrgOverview(req.primaryOrgId);
        res.json(overview);
    } catch (e) {
        log.error('[learning/org-overview] failed:', e.message);
        res.status(500).json({ error: 'Failed to load learning overview' });
    }
});

// ── Required training ────────────────────────────────────────────────────
//
// Two routes, one for each side of the rule. The member route exists so the
// client can lock a create button WITH ITS REASON before it is pressed — a 403
// discovered at Save costs somebody the work they just did, and tells them
// nothing about which course lifts it.

// GET /training-gates → { areas: { [areaId]: { enforced, satisfied, courseId,
// courseTitle, lessonsDone, lessonsTotal } }, catalog: [...] } for the caller.
router.get('/training-gates', requireAuth, async (req, res) => {
    try {
        const orgPublished = await orgCoursesFor(req);
        const extraCourses = orgPublished.map(({ course }) => ({
            id: course.id, lessonIds: course.lessonIds, title: course.title, badge: course.badge,
        }));
        const areas = await evaluateForRequest(req, { extraCourses });
        res.json({ areas, catalog: TRAINING_AREAS });
    } catch (e) {
        log.error('[learning/training-gates] failed:', e.message);
        // Fail open: a client that cannot read the gates must not lock its own
        // buttons. The server still enforces on write.
        res.json({ areas: {}, catalog: TRAINING_AREAS });
    }
});

// GET /training-rules → what the org has configured, plus the courses an admin
// may point an area at (built-ins + the org's own published courses).
router.get('/training-rules', requireAuth, requirePrimaryOrgAdmin(), async (req, res) => {
    try {
        const [settings, orgPublished] = await Promise.all([
            getTrainingSettings(req.primaryOrgId),
            orgCoursesFor(req),
        ]);
        const courses = [
            ...COURSES.map((c) => ({ id: c.id, title: c.title, lessons: (c.lessonIds || []).length, own: false })),
            ...orgPublished.map(({ course }) => ({
                id: course.id, title: course.title, lessons: (course.lessonIds || []).length, own: true,
            })),
        ];
        res.json({ areas: settings.areas, updatedAt: settings.updatedAt, catalog: TRAINING_AREAS, courses });
    } catch (e) {
        log.error('[learning/training-rules] read failed:', e.message);
        res.status(500).json({ error: 'Failed to load training rules' });
    }
});

// PUT /training-rules { areas: { [areaId]: courseId } } — replaces the whole
// map, so removing a key removes the rule. Unknown area ids are dropped by
// normalizeSettings; an unknown COURSE id is refused here rather than stored,
// because a rule pointing at a course nobody can open would lock the area for
// good (courseSatisfied would answer null and fail open, but an admin who
// thinks they gated something and did not is worse than a loud 400).
router.put('/training-rules', requireAuth, requirePrimaryOrgAdmin(), validate({ body: TrainingRulesBody }), async (req, res) => {
    try {
        const incoming = req.body?.areas;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
            return res.status(400).json({ error: 'areas must be an object of { areaId: courseId }' });
        }
        const orgPublished = await orgCoursesFor(req);
        const knownCourseIds = new Set([
            ...COURSES.map((c) => c.id),
            ...orgPublished.map(({ course }) => course.id),
        ]);
        const unknown = Object.entries(incoming)
            .filter(([, courseId]) => !knownCourseIds.has(courseId))
            .map(([areaId, courseId]) => `${areaId} → ${courseId}`);
        if (unknown.length) {
            return res.status(400).json({ error: 'unknown_course', detail: unknown });
        }
        const saved = await setTrainingSettings(req.primaryOrgId, incoming, req.session.user.id);
        res.json({ areas: saved.areas, updatedAt: saved.updatedAt });
    } catch (e) {
        log.error('[learning/training-rules] write failed:', e.message);
        res.status(500).json({ error: 'Failed to save training rules' });
    }
});

module.exports = router;
