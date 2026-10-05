/**
 * Migration: teach the seeded memory-extractor prompt that a reply language is
 * not a preference (BFSF-387).
 *
 * The extractor saved one-off corrections ("in het Nederlands graag") as a
 * lasting `language: Dutch` preference. Active Memory then carried it into
 * every later chat, and the chat kept answering in Dutch whatever language the
 * user wrote in. The prompt builders now also say a remembered language never
 * decides the reply language; this stops new ones being written.
 *
 * Why a migration: `system-memory-extractor` is `alwaysUpdate: false`, so the
 * .md file only reaches new installs (see memory-extractor-prompt-2026-08.js).
 * Like that one, this only APPENDS a section, once, so an operator's edits to
 * the rest of the prompt stay. Idempotent: keyed off the section heading.
 */

const { getOne, run } = require('../db');

const AGENT_ID = 'system-memory-extractor';
const HEADING = '## Reply language is not a preference';

const LANGUAGE_GUIDANCE = `

${HEADING}

Do not save the language the user happens to write in, or a one-off request such as
"answer in Dutch" or "in English please", as a preference: the assistant already
replies in the language of each message. Save a \`language\` preference only when the
user says it must ALWAYS apply, whatever language they write in.`;

function correctPrompt(prompt) {
    const out = String(prompt || '');
    return out.includes(HEADING) ? out : out + LANGUAGE_GUIDANCE;
}

async function up() {
    let row;
    try {
        row = await getOne('SELECT id, system_prompt FROM agents WHERE id = $1', [AGENT_ID]);
    } catch (e) {
        console.log('[migration:memory-extractor-language] agents table not ready — skipping');
        return;
    }
    if (!row?.system_prompt) {
        console.log('[migration:memory-extractor-language] agent not seeded yet — nothing to do');
        return;
    }
    const next = correctPrompt(row.system_prompt);
    if (next === row.system_prompt) {
        console.log('[migration:memory-extractor-language] already current — nothing to do');
        return;
    }
    await run('UPDATE agents SET system_prompt = $1, updated_at = NOW() WHERE id = $2', [next, AGENT_ID]);
    console.log('[migration:memory-extractor-language] appended the reply-language guidance');
}

module.exports = { up, correctPrompt, AGENT_ID, HEADING, LANGUAGE_GUIDANCE };
