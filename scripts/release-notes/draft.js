#!/usr/bin/env node
/**
 * Draft release notes inside GitHub Actions.
 *
 *   node scripts/release-notes/draft.js --material payload.json --out-dir .
 *
 * Writes two files to --out-dir:
 *   notes.json  the draft: { title, lead, items[] } — POSTed to /ingest
 *   notes.md    the same draft rendered — the GitHub Release body
 *
 * ── Why this exists next to the server's drafter ───────────────────────────
 *
 * The server can draft perfectly well (server/core/releaseNotesDrafter.js) and
 * still does when this script does not run. What the server cannot do is put
 * the notes in the GitHub Release: the Release is cut in the same workflow run,
 * minutes later, and the runner would have to poll the app for a draft it may
 * not be allowed to read. Drafting here makes the notes a value in the run.
 *
 * The prompt, schema and coercion come from server/core/releaseNotesFormat.js —
 * shared with the server path so both write identical entries.
 *
 * ── Failure policy ─────────────────────────────────────────────────────────
 *
 * BEST-EFFORT, like every other step in the release-notes job: a changelog must
 * never be the reason a build fails. Any failure exits 0 WITHOUT writing
 * notes.json, which the workflow reads as "post the raw material instead" — the
 * server then drafts it the old way. The only thing lost is the Release body.
 *
 * An empty range is NOT a failure: it writes notes.json with an empty items
 * array, which is the honest answer and saves the server a model call.
 */

const fs = require('fs');
const path = require('path');

const Anthropic = require('@anthropic-ai/sdk');
const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema');

const fmt = require('../../server/core/releaseNotesFormat');

// Sonnet 5 rather than an Opus tier: this is summarise-and-classify over a few
// hundred short lines, the schema does the structuring, and it runs on every
// merge to main. Raise it here if the notes ever read thin.
const MODEL = process.env.RELEASE_NOTES_MODEL || 'claude-sonnet-5';

/** GitHub Actions annotations — one line, so they surface in the job log. */
const notice = (m) => console.log(`::notice::${m}`);
const warn = (m) => console.log(`::warning::${m}`);

function parseArgs(argv) {
    const out = { material: 'payload.json', outDir: '.' };
    for (let i = 2; i < argv.length; i += 2) {
        if (argv[i] === '--material') out.material = argv[i + 1];
        else if (argv[i] === '--out-dir') out.outDir = argv[i + 1];
    }
    return out;
}

function write(outDir, draft) {
    fs.writeFileSync(path.join(outDir, 'notes.json'), JSON.stringify(draft, null, 2));
    fs.writeFileSync(path.join(outDir, 'notes.md'), fmt.renderMarkdown(draft));
}

/**
 * Pull the draft out of the response.
 *
 * `parsed_output` is what structured outputs are for, but a refusal or a
 * truncation leaves it null — fall back to parsing the text so a usable reply
 * is not thrown away over a missing field.
 */
function extractDraft(message) {
    if (message.stop_reason === 'refusal') {
        throw new Error(`model refused: ${message.stop_details?.category || 'unknown'}`);
    }
    if (message.parsed_output) return fmt.coerceDraft(message.parsed_output);

    const text = (message.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    if (!text.trim()) throw new Error(`empty reply (stop_reason: ${message.stop_reason})`);
    return fmt.coerceDraft(JSON.parse(fmt.stripFence(text)));
}

async function main() {
    const { material: materialPath, outDir } = parseArgs(process.argv);
    const material = JSON.parse(fs.readFileSync(materialPath, 'utf8'));

    const commits = fmt.normaliseLines(material.commitSubjects);
    const prs = fmt.normaliseLines(material.prTitles);

    // Nothing to summarise — do not spend a model call to be told so.
    if (!commits.length && !prs.length) {
        notice('release notes: empty range, nothing to draft');
        write(outDir, { title: '', lead: '', items: [] });
        return;
    }

    const client = new Anthropic();   // reads ANTHROPIC_API_KEY

    const message = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: fmt.SYSTEM_PROMPT,
        messages: [{ role: 'user', content: fmt.buildUserPayload(material) }],
        thinking: { type: 'adaptive' },
        output_config: {
            effort: 'medium',
            format: jsonSchemaOutputFormat(fmt.NOTES_SCHEMA),
        },
    });

    const draft = extractDraft(message);
    write(outDir, draft);

    const u = message.usage || {};
    notice(
        `release notes: ${draft.items.length} item(s) drafted by ${message.model || MODEL} `
        + `(${u.input_tokens || 0} in / ${u.output_tokens || 0} out)`,
    );
}

main().catch((err) => {
    // Deliberately exit 0: no notes.json means "server, you draft it".
    warn(`release notes: CI drafting failed (${err.message}) — falling back to server-side drafting`);
    process.exit(0);
});
