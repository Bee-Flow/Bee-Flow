// Validation + clamps for AI-generated practice questions (v2).
//
// The generator (routes/ai/learning.js POST /practice/generate) forces the
// model through ONE tool call with the schema below — but the model's output is
// UNTRUSTED (the automation/suggestions.js doctrine): every field is re-checked
// and clamped here before an answer key is minted. Pure module, no stores, no
// network — unit-tested directly with node:test.

const MAX_ITEMS = 6;
const MIN_CHOICES = 3;
const MAX_CHOICES = 4;
const MAX_QUESTION_CHARS = 300;
const MAX_LABEL_CHARS = 200;
const MAX_EXPLANATION_CHARS = 400;

// Choice ids are minted HERE (a–d, in the model's order) — the model never
// names ids, which removes a whole class of duplicate/garbage-id failures.
const CHOICE_IDS = ['a', 'b', 'c', 'd'];

// The forced-tool schema for llmClient.chatForcedTool. Kept beside the
// validator so schema and clamps can't drift apart.
const PRACTICE_TOOL = {
    type: 'function',
    function: {
        name: 'submit_practice_items',
        description: 'Submit the generated multiple-choice practice questions.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
                items: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_ITEMS,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['lessonId', 'question', 'choices', 'explanation'],
                        properties: {
                            lessonId: { type: 'string', description: 'Which requested lesson this question practices' },
                            question: { type: 'string', description: 'One clear multiple-choice question' },
                            choices: {
                                type: 'array',
                                minItems: MIN_CHOICES,
                                maxItems: MAX_CHOICES,
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['label', 'correct'],
                                    properties: {
                                        label: { type: 'string' },
                                        correct: { type: 'boolean', description: 'Exactly ONE choice per question is true' },
                                    },
                                },
                            },
                            explanation: { type: 'string', description: 'Why the correct answer is right — shown after grading' },
                        },
                    },
                },
            },
        },
    },
};

function cleanString(value, maxLen) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    return s.slice(0, maxLen);
}

// Normalize the model's tool-call payload into gradeable items, or null when
// nothing usable survives. Per item: clamp lengths, require 3–4 choices with
// EXACTLY one correct, mint a/b/c/d ids, and pin lessonId to the requested set
// (unknown → the first requested lesson). Malformed items are dropped, not
// repaired — a bad question is worse than one fewer question.
function validatePracticeItems(parsed, allowedLessonIds = []) {
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : null;
    if (!rawItems) return null;
    const allowed = new Set(allowedLessonIds);
    const fallbackLesson = allowedLessonIds[0] || null;

    const items = [];
    for (const raw of rawItems) {
        if (items.length >= MAX_ITEMS) break;
        if (!raw || typeof raw !== 'object') continue;
        const question = cleanString(raw.question, MAX_QUESTION_CHARS);
        const explanation = cleanString(raw.explanation, MAX_EXPLANATION_CHARS);
        if (!question || !explanation) continue;

        const rawChoices = Array.isArray(raw.choices) ? raw.choices.slice(0, MAX_CHOICES) : [];
        const choices = [];
        for (const c of rawChoices) {
            const label = cleanString(c?.label, MAX_LABEL_CHARS);
            if (!label) continue;
            choices.push({ id: CHOICE_IDS[choices.length], label, correct: c?.correct === true });
        }
        if (choices.length < MIN_CHOICES) continue;
        if (choices.filter((c) => c.correct).length !== 1) continue;

        const lessonId = allowed.has(raw.lessonId) ? raw.lessonId : fallbackLesson;
        if (!lessonId) continue;
        items.push({ lessonId, question, choices, explanation });
    }
    return items.length ? items : null;
}

// Strip an item down to what the client may see: no `correct`, no explanation
// (the explanation arrives with the grade, so it can't spoil the answer).
function publicPracticeItem(item, id) {
    return {
        id,
        lessonId: item.lessonId,
        question: item.question,
        choices: item.choices.map((c) => ({ id: c.id, label: c.label })),
    };
}

module.exports = {
    PRACTICE_TOOL,
    validatePracticeItems,
    publicPracticeItem,
    MAX_ITEMS,
};
