/**
 * Migration: correct two stale lines in the seeded memory-extractor prompt.
 *
 * ── Why a migration and not just editing the prompt file ─────────────────────
 * `system-memory-extractor` is registered with `alwaysUpdate: false`, so
 * `seedSystemAgents` writes its prompt exactly once, when the agent row is
 * created. Editing `stores/agent/prompts/memory-extractor.md` therefore fixes
 * new installs and nothing else — every existing install keeps the copy it was
 * seeded with, forever.
 *
 * ── What is stale, and why it matters ────────────────────────────────────────
 * The prompt documents an output shape that no longer matches the structured
 * schema the extractor actually enforces:
 *
 *   • `"subject": "user|project|agent"` — `(type, subject, attribute)` is the
 *     canonical key `createMemory` dedupes and SUPERSEDES on. With subject
 *     restricted to three values, every person's role collapses to
 *     `(person, 'user', 'role')`, so the second colleague the assistant learns
 *     about silently replaces the first. Not weak dedupe — data loss.
 *
 *   • `"type": "fact|preference|instruction"` — three of the seven types the
 *     schema, the prompt renderer, the type scores and the Manage UI all
 *     understand. The other four could never be produced.
 *
 * ── Why targeted replacement rather than overwriting the prompt ──────────────
 * This prompt is operator-editable in the admin UI, and some installs will have
 * tuned it. Rewriting the row wholesale would silently discard that work, and
 * flipping `alwaysUpdate: true` would do the same on every boot. So this
 * replaces only the two exact lines, and only where they still appear verbatim.
 * An operator who has already rewritten that block is left alone.
 *
 * Idempotent: after the first run the old strings are gone, so it matches
 * nothing and updates nothing.
 */

const { getOne, run } = require('../db');

const AGENT_ID = 'system-memory-extractor';

// Each entry is [stale, corrected]. Matched verbatim; anything that has drifted
// is deliberately left untouched.
const REPLACEMENTS = [
    [
        '"subject": "user|project|agent",',
        '"subject": "The entity this is about: a person\'s full name, a project or company name, or \\"user\\" for the person you are talking to",',
    ],
    [
        '"type": "fact|preference|instruction",',
        '"type": "fact|preference|instruction|person|project|workflow|context",',
    ],
];

// Appended once, so the model is told what the canonical key MEANS rather than
// only what shape to emit. Keyed off its first line for the idempotence check.
const CANONICAL_KEY_GUIDANCE = `

## The canonical key

\`(type, subject, attribute)\` is a KEY. Re-observing the same key confirms the
existing memory; the same key with a different value replaces it. So the same
entity must always produce the same \`subject\` string, and the same property the
same \`attribute\` string — "Tom Kooy" and "tom" are two different people as far
as this system is concerned, and \`role\` and \`job_title\` are two different facts.

Never use a pronoun or a description as a subject. Two people's roles must not
share a subject, or the second one recorded will replace the first.`;

async function up() {
    let row;
    try {
        row = await getOne('SELECT id, system_prompt FROM agents WHERE id = $1', [AGENT_ID]);
    } catch (e) {
        // Fresh database: the agents table is seeded later in boot, and a new
        // install gets the corrected prompt from the file anyway.
        console.log('[migration:memory-extractor-prompt] agents table not ready — skipping');
        return;
    }
    if (!row?.system_prompt) {
        console.log('[migration:memory-extractor-prompt] agent not seeded yet — nothing to do');
        return;
    }

    let prompt = row.system_prompt;
    const applied = [];

    for (const [stale, corrected] of REPLACEMENTS) {
        if (prompt.includes(stale)) {
            prompt = prompt.split(stale).join(corrected);
            applied.push(stale.slice(0, 24));
        }
    }

    if (!prompt.includes('## The canonical key')) {
        prompt += CANONICAL_KEY_GUIDANCE;
        applied.push('canonical-key guidance');
    }

    if (applied.length === 0) {
        console.log('[migration:memory-extractor-prompt] already current — nothing to do');
        return;
    }

    await run('UPDATE agents SET system_prompt = $1, updated_at = NOW() WHERE id = $2', [prompt, AGENT_ID]);
    console.log(`[migration:memory-extractor-prompt] updated ${applied.length} section(s): ${applied.join(', ')}`);
}

/**
 * Apply the same correction to a prompt string. The seeded file
 * (stores/agent/prompts/memory-extractor.md) is kept equal to the output of
 * this function so a fresh install and a migrated install end up with the
 * same prompt — see stores/agent/prompts/memory-extractor.md.
 */
function correctPrompt(prompt) {
    let out = String(prompt || '');
    for (const [stale, corrected] of REPLACEMENTS) {
        if (out.includes(stale)) out = out.split(stale).join(corrected);
    }
    if (!out.includes('## The canonical key')) out += CANONICAL_KEY_GUIDANCE;
    return out;
}

module.exports = { up, correctPrompt, AGENT_ID, REPLACEMENTS, CANONICAL_KEY_GUIDANCE };
