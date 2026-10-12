'use strict';
/**
 * The content rules for an inferred memory, shared by the extractor (what may
 * be written now) and the consolidation job (what already written rows would no
 * longer pass). One definition, so the two cannot drift apart.
 */

const TASK_VERBS = /^(the user wants to|user wants|create|write|fix|build|make|generate|show|explain|help|add|remove|update|delete|edit|modify|change|set|get|fetch|load|save|open|close|run|execute|deploy|test|debug|refactor)\b/i;

/** Extractor rules: task-like content and questions are not memories. */
const isTaskLike = (content) => TASK_VERBS.test(String(content || '').trim());
const isQuestion = (content) => String(content || '').trim().endsWith('?');

/** A request to the assistant ("kan je ...", "can you ..."), not a fact about the user. Conservative, NL + EN. */
const ASSISTANT_REQUEST = /^(kan je|kun je|kunt u|zou je|wil je|can you|could you|would you|will you|please|alsjeblieft|zorg dat|zorg ervoor|maak|schrijf|geef me|laat zien|help me|give me|show me|write me|make me)\b/i;
/** A short first-person conversation fragment ("ik zie het nog niet"), not a stored fact. */
const FIRST_PERSON_FRAGMENT = /^(ik|i|i'm|i am|mijn|my|we|wij)\s/i;

const hasLetters = (s) => /\p{L}/u.test(s);

/**
 * Why a stored inferred memory fails today's rules, or null when it passes.
 * @param {string} content
 * @returns {string|null}
 */
function junkReason(content) {
    const text = String(content || '').trim();
    if (!hasLetters(text)) return 'no-letters';
    if (text.length < 12 || text.length > 500) return 'length';
    if (isTaskLike(text)) return 'task';
    if (isQuestion(text)) return 'question';
    if (text.endsWith(':')) return 'trailing-colon';
    if (ASSISTANT_REQUEST.test(text)) return 'request';
    if (FIRST_PERSON_FRAGMENT.test(text) && text.length < 40) return 'fragment';
    return null;
}

/**
 * The strict subset for inferred INSTRUCTION rows. An instruction is imperative
 * ("write shorter answers"), so the task-verb, question and request rules would
 * hit good rows; only what is certainly not an instruction is junk here:
 * letterless, shorter than 12 characters, a dangling "Include:", or a short
 * first-person conversation fragment.
 * @param {string} content
 * @returns {string|null}
 */
function strictJunkReason(content) {
    const text = String(content || '').trim();
    if (!hasLetters(text)) return 'no-letters';
    if (text.length < 12) return 'length';
    if (text.endsWith(':')) return 'trailing-colon';
    if (FIRST_PERSON_FRAGMENT.test(text) && text.length < 40) return 'fragment';
    return null;
}

const normaliseText = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

module.exports = { TASK_VERBS, isTaskLike, isQuestion, junkReason, strictJunkReason, normaliseText };
