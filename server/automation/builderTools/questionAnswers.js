/**
 * Reading the text the chat sends after a question card ("Q: ...\nA: ...", one
 * block per question, a blank line between). One port for both readers: the
 * work-mode note that tells the model its questions were answered
 * (routes/ai/automationBuilder/workMode.js) and the table-consent gate
 * (datatableApproval.js).
 *
 * It is a port of agent-hub/src/components/automation/Builder/chat/
 * questionAnswers.ts (the twin writes the text). Each side has a fixture test;
 * if one changes, change both, or answers stop being recognised and the user is
 * asked again.
 */

'use strict';

const PAIR = /^Q: ([^\n]+)\nA: ([^\n]+)$/;

/** Q/A message text → [{prompt, answer}], or null when it is not exactly that shape. */
function parseAnswersText(content) {
    if (typeof content !== 'string' || !content.startsWith('Q: ')) return null;
    const answers = [];
    for (const block of content.split('\n\n')) {
        const m = PAIR.exec(block);
        if (!m) return null;
        answers.push({ prompt: m[1], answer: m[2] });
    }
    return answers;
}

module.exports = { parseAnswersText };
