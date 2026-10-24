const { usageLogFields } = require('../../core/providers/usageNormalizer');
const log = require('../../telemetry/log');
const crypto = require('crypto');
const usageStore = require('../../stores/usageStore');
const { resolveModelForTier, resolveModelWithGlobalFallback } = require('../../core/llm/modelResolver');
const configStore = require('../../stores/configStore');
const { z, worded, bodyOf, typeError } = require('../../core/http/schemaParts');

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

const choiceIds = z.array(z.union([z.string(), z.number()]), { error: typeError({ invalid: 'choiceIds is a list of answer ids.' }) }).optional();

const CoachBody = bodyOf({
    exerciseId: lText('exerciseId', 300).optional(),
    mode: z.enum(['grade', 'hint'], { error: () => 'mode is grade or hint.' }).optional(),
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
    lessonIds: z.array(z.union([z.string(), z.number()]), { error: typeError({ invalid: 'lessonIds is a list of lesson ids.' }) }).optional(),
    count: z.union([z.number(), z.string()], { error: typeError({ invalid: 'count is a number.' }) }).optional(),
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
    makePublic: z.boolean({ error: typeError({ invalid: 'makePublic is true or false.' }) }).optional(),
}, 'A certificate request');

const TrainingRulesBody = bodyOf({
    areas: z.record(z.string(), z.unknown(), { error: typeError({ required: 'areas must be an object of { areaId: courseId }', invalid: 'areas must be an object of { areaId: courseId }' }) }),
}, 'The training rules');

// 'thinking' is deliberately excluded: a 600-token rubric grade never needs an
// expensive reasoning model (the client only ever sends 'fast' today).
const ALLOWED_TIERS = new Set(['fast', 'standard', 'auto']);

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
            // Normalised by the adapter (providers/usageNormalizer.js): cache read/write,
            // the 5m/1h split and reasoning tokens ride along.
            ...usageLogFields(usage),
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
    } catch (err) { log.debug('fall through', err); }
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
    try { return JSON.parse(text); } catch (err) { log.debug('try to extract', err); }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
        try { return JSON.parse(text.slice(first, last + 1)); } catch (err) { log.debug('give up', err); }
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

const PRACTICE_TTL_MS = 24 * 60 * 60 * 1000;

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

module.exports = { CoachBody, TutorBody, PracticeBody, PracticeGradeBody, QuizGradeBody, CertificateBody, TrainingRulesBody, verdictCacheKey, verdictCacheGet, verdictCacheSet, logCoachUsage, resolveModel, recordExerciseAttempt, parseJsonLoose, TUTOR_SYSTEM, GRADER_SYSTEM, HINT_SYSTEM, PRACTICE_TTL_MS, practiceCachePrune, PRACTICE_SYSTEM };
