/**
 * Migration: teach the seeded memory-extractor prompt about sensitivity, what
 * never to save, and absolute dates (memory write pipeline, 2026-10).
 *
 * The write pipeline (agents/memory/memoryWriter.js) now drops identifiers and
 * credentials, and holds special-category (GDPR Art. 9) facts back for the
 * user's consent. It can only do that well when the extractor says which facts
 * are Art. 9 (`sensitivity: "art9"`) and stops offering what must never be
 * kept.
 *
 * Why a migration: `system-memory-extractor` is `alwaysUpdate: false`, so the
 * .md file only reaches new installs. Like memory-extractor-language-2026-10.js
 * this only APPENDS a section, once, so an operator's edits to the rest of the
 * prompt stay. Idempotent: keyed off the section heading.
 */

const { getOne, run } = require('../db');

const AGENT_ID = 'system-memory-extractor';
const HEADING = '## Sensitivity, exclusions and dates';

const SENSITIVITY_GUIDANCE = `

${HEADING}

Every memory has a \`sensitivity\` field: "none" or "art9". Use "art9" for health
and medical conditions, religion or belief, political opinion, sexual orientation
or sex life, ethnic origin, trade union membership, and genetic or biometric data.
Do not leave such a fact out and do not describe it vaguely: mark it "art9" and
the system decides whether it may be kept.

Never extract, whatever the user says:
- government ID numbers (BSN, passport, driving licence, social security, tax id)
- bank account (IBAN), card numbers, passwords, API keys, tokens and other secrets
- facts about third parties, unless they are clearly needed for the user's work
  (a colleague's role is fine; a colleague's health is not)
- anything that only appears in a pasted document, email, code or tool output:
  save only what the user states about themselves, in their own words

Write dates as absolute dates. The user message starts with today's date; turn
"next Friday" or "last month" into the actual date in \`content\` and \`value\`.`;

function correctPrompt(prompt) {
    const out = String(prompt || '');
    return out.includes(HEADING) ? out : out + SENSITIVITY_GUIDANCE;
}

async function up() {
    let row;
    try {
        row = await getOne('SELECT id, system_prompt FROM agents WHERE id = $1', [AGENT_ID]);
    } catch (e) {
        console.log('[migration:memory-extractor-sensitivity] agents table not ready — skipping');
        return;
    }
    if (!row?.system_prompt) {
        console.log('[migration:memory-extractor-sensitivity] agent not seeded yet — nothing to do');
        return;
    }
    const next = correctPrompt(row.system_prompt);
    if (next === row.system_prompt) {
        console.log('[migration:memory-extractor-sensitivity] already current — nothing to do');
        return;
    }
    await run('UPDATE agents SET system_prompt = $1, updated_at = NOW() WHERE id = $2', [next, AGENT_ID]);
    console.log('[migration:memory-extractor-sensitivity] appended the sensitivity guidance');
}

module.exports = { up, correctPrompt, AGENT_ID, HEADING, SENSITIVITY_GUIDANCE };
