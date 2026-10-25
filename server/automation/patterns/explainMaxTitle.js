// @typecheck strict
const { TOOL_REGISTRY } = require('../toolRegistry');

const MAX_TITLE = 80;

const MAX_WHY = 200;

const MAX_PROMPT = 1200;

// Refs are letters, so the prompt itself adds no digits a model could echo.
const MAX_CARDS = 26;

const NAMING_OPTIONS = Object.freeze({ maxTokens: 4096, temperature: 0.2, reasoningEffort: 'none' });

const NAME_PATTERNS_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'name_patterns',
        description: 'Name and explain each repeating-work pattern card.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['patterns'],
            properties: {
                patterns: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['ref', 'title', 'why', 'buildPrompt'],
                        properties: {
                            ref: { type: 'string', description: 'The ref of the card you are naming, e.g. "A".' },
                            title: { type: 'string', description: 'A short, plain name for the automation that takes this work over. At most 8 words, no numbers.' },
                            why: { type: 'string', description: 'One sentence on what repeats and why automating it helps. No numbers.' },
                            buildPrompt: { type: 'string', description: 'A complete instruction for the automation builder: the trigger, each step in order and what flows between them.' },
                        },
                    },
                },
            },
        },
    },
});

const SYSTEM_PROMPT = [
    'You name repeating work that a deterministic analysis found in one person\'s own activity.',
    'Each card describes one pattern: what kind it is, the apps and actions involved, how often and how regularly it happened, and a draft automation (trigger and steps).',
    'Placeholders such as <n>, <date>, <id>, <name>, <org>, <email>, <url>, <domain>, <*> and <domain:A> stand for values that vary or were hidden. Never guess what they stand for.',
    '',
    'Call name_patterns exactly once, with one entry per card:',
    '- ref: the card\'s ref.',
    '- title: a short, plain name for the automation that would take this work over (at most 8 words, no numbers, no placeholders).',
    '- why: one sentence for a non-technical reader on what repeats and why automating it helps. No numbers: the page shows the measured numbers itself.',
    '- buildPrompt: a complete, self-contained instruction for an automation builder: the trigger, each step in order and what flows between the steps, based only on the card. You may quote the template with its placeholders.',
    '',
    'Rules: write in English. Use only what the cards say. Never invent people, companies, addresses, links, amounts or numbers. Never compute new numbers from the card.',
].join('\n');

/** @type {Map<string, string>} */
const APP_LABELS = new Map([
    ...TOOL_REGISTRY.map((e) => /** @type {[string, string]} */ ([e.app, e.label])),
    ['teams', 'Microsoft Teams'],
    ['gmeet', 'Google Meet'],
    ['meetings', 'Meeting notes'],
    ['beeflow', 'Bee Flow'],
    ['chat', 'Bee Flow chat'],
    ['documents', 'the knowledge base'],
]);

// In the model's text "1,5" is a number; in the card's JSON a comma separates.
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;

module.exports = { MAX_TITLE, MAX_WHY, MAX_PROMPT, MAX_CARDS, NAMING_OPTIONS, NAME_PATTERNS_TOOL, SYSTEM_PROMPT, APP_LABELS, NUMBER_RE };
