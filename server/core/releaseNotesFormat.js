/**
 * releaseNotesFormat — the shared contract for release-note drafting.
 *
 * Deliberately DEPENDENCY-FREE. Two callers with very different environments
 * load this module and must stay in lockstep:
 *
 *   1. server/core/releaseNotesDrafter.js — drafts via llmClient, so the call
 *      honours EU-mode and org tier overrides.
 *   2. scripts/draft-release-notes.mjs    — drafts in GitHub Actions via the
 *      Anthropic SDK, so the notes exist before the GitHub Release is cut.
 *
 * Both produce the same shape, so whichever one runs, the store, the public
 * changelog block and the Release body all see identical data. Anything that
 * lives in only one of them is a source of drift — put it here instead.
 *
 * The CI path runs from a bare checkout with no server node_modules installed.
 * Never add a require() to this file.
 */

const MAX_SUBJECTS = 200;
const MAX_TITLE_LEN = 120;
const MAX_ITEMS = 25;

const VALID_KINDS = new Set(['feature', 'improvement', 'fix']);

const SYSTEM_PROMPT = `You write release notes for Bee Flow, a self-hosted privacy-first AI workspace.

You are given commit subjects, pull-request titles and a diffstat from one release range.
Turn them into notes a CUSTOMER can read.

Rules:
- Write for someone who uses the product and does not read the code. No file paths, no
  function names, no branch names, no commit hashes, no internal ticket ids (BFSF-123).
- Describe the effect on the user, not the implementation. "Chat no longer loses an
  answer when you navigate away" — not "fixed conversation persistence in chatStream".
- Drop anything with no user-visible effect: dependency bumps, CI changes, refactors,
  test-only work, formatting. Silence is better than filler.
- Group each entry as "feature" (new capability), "improvement" (existing thing got
  better) or "fix" (something broken now works).
- Merge duplicates. Several commits on one feature are ONE entry.
- Never invent. If the material does not say a thing happened, it did not happen.
- If nothing in the range is user-visible, return an empty items array. An honest empty
  release note is correct; padding it is not.

Reply with JSON only, no prose and no code fence:
{
  "title": "short headline for the whole release, max 60 chars",
  "lead": "one or two sentences summarising the release for a customer",
  "items": [{"kind": "feature|improvement|fix", "title": "short", "body": "one or two sentences"}]
}`;

/**
 * The same contract as the tail of SYSTEM_PROMPT, in the form the Anthropic
 * structured-outputs API wants. The CI path constrains the response with this,
 * so there is no fence to strip and no unparseable reply to swallow. The server
 * path goes through llmClient, which fronts providers with no shared
 * structured-output surface, so there the prompt text is the only contract.
 *
 * Keep the two in sync — one schema, written twice because two transports need
 * it in two forms.
 */
const NOTES_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string', description: 'Short headline for the whole release, max 60 chars' },
        lead: { type: 'string', description: 'One or two sentences summarising the release for a customer' },
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['feature', 'improvement', 'fix'] },
                    title: { type: 'string', description: 'Short entry headline' },
                    body: { type: 'string', description: 'One or two sentences' },
                },
                required: ['kind', 'title', 'body'],
                additionalProperties: false,
            },
        },
    },
    required: ['title', 'lead', 'items'],
    additionalProperties: false,
};

/** Trim, de-duplicate and cap a list of git subject lines. */
function normaliseLines(input, cap = MAX_SUBJECTS) {
    const arr = Array.isArray(input)
        ? input
        : String(input || '').split('\n');
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        const s = String(raw || '').trim();
        if (!s) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= cap) break;
    }
    return out;
}

/**
 * Coerce whatever the model returned into the shape the store and renderer
 * expect.
 *
 * An unknown `kind` is mapped to 'improvement' rather than dropped — the same
 * principle the roadmap block applies to an unrecognised status. Losing a real
 * change because the model wrote "enhancement" would be worse than filing it in
 * a slightly wrong bucket.
 *
 * Structured outputs make an unknown kind unlikely on the CI path, but this
 * still runs there: it is also what re-validates an entry that arrived over the
 * wire at /ingest, where the shape is whatever the caller sent.
 */
function coerceDraft(parsed) {
    const obj = (parsed && typeof parsed === 'object') ? parsed : {};
    const rawItems = Array.isArray(obj.items) ? obj.items : [];

    const items = [];
    for (const it of rawItems) {
        if (!it || typeof it !== 'object') continue;
        const title = String(it.title || '').trim().slice(0, MAX_TITLE_LEN);
        const body = String(it.body || '').trim();
        if (!title && !body) continue;
        const kindRaw = String(it.kind || '').trim().toLowerCase();
        items.push({
            kind: VALID_KINDS.has(kindRaw) ? kindRaw : 'improvement',
            title,
            body,
        });
        if (items.length >= MAX_ITEMS) break;
    }

    return {
        title: String(obj.title || '').trim().slice(0, MAX_TITLE_LEN),
        lead: String(obj.lead || '').trim(),
        items,
    };
}

/** Strip a code fence the model may have added despite being told not to. */
function stripFence(text) {
    return String(text || '').trim()
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
}

/**
 * Build the user turn from one range's raw git material.
 *
 * PR titles come FIRST because they carry most of the signal. Measured on this
 * repo: ~61% of commits use a conventional-commit prefix but only ~4% reference
 * a BFSF issue id, so issue ids are not a usable grouping key — merge titles are.
 */
function buildUserPayload(material = {}) {
    const commits = normaliseLines(material.commitSubjects);
    const prs = normaliseLines(material.prTitles);

    return [
        material.version ? `Version: ${material.version}` : 'Version: unreleased',
        material.services ? `Services changed: ${material.services}` : '',
        '',
        'Pull request titles:',
        prs.length ? prs.map(s => `- ${s}`).join('\n') : '(none)',
        '',
        'Commit subjects:',
        commits.length ? commits.map(s => `- ${s}`).join('\n') : '(none)',
        '',
        material.diffstat ? `Diffstat:\n${String(material.diffstat).slice(0, 4000)}` : '',
    ].filter(Boolean).join('\n');
}

/** Customer-facing headings. The stored `kind` stays machine-readable. */
const KIND_HEADINGS = {
    feature: 'New',
    improvement: 'Improved',
    fix: 'Fixed',
};

/**
 * Render a draft as Markdown for the GitHub Release body and the job summary.
 *
 * Returns '' for an empty draft rather than a heading with nothing under it —
 * the Release body then falls back to GitHub's own generated commit list, which
 * is a better answer than an empty "What's new".
 */
function renderMarkdown(draft = {}) {
    const { title, lead, items } = coerceDraft(draft);
    if (!title && !lead && !items.length) return '';

    const out = [];
    if (title) out.push(`## ${title}`, '');
    if (lead) out.push(lead, '');

    for (const kind of ['feature', 'improvement', 'fix']) {
        const group = items.filter(i => i.kind === kind);
        if (!group.length) continue;
        out.push(`### ${KIND_HEADINGS[kind]}`, '');
        for (const it of group) {
            out.push(it.body ? `- **${it.title}** — ${it.body}` : `- **${it.title}**`);
        }
        out.push('');
    }

    return out.join('\n').trim();
}

module.exports = {
    SYSTEM_PROMPT,
    NOTES_SCHEMA,
    KIND_HEADINGS,
    MAX_SUBJECTS,
    MAX_TITLE_LEN,
    MAX_ITEMS,
    normaliseLines,
    coerceDraft,
    stripFence,
    buildUserPayload,
    renderMarkdown,
};
