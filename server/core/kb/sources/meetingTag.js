// @typecheck
/**
 * Meetings carrying a tag, as a knowledge source ("after every meeting").
 *
 * Tag a meeting `sales` and its summary becomes searchable in the knowledge
 * base — so the answer to "what did we agree with Van Dijk about the
 * discount?" comes from the meeting where it was agreed, not from somebody's
 * memory of it.
 *
 * ── THIS SOURCE WIDENS WHO CAN READ A MEETING, AND THAT IS THE RISK ─
 * A meeting note has its own audience: its owner, whoever it was shared with,
 * and — if published — an organisation or a group. Putting its summary into a
 * knowledge base moves it into THAT thing's audience instead, which may be
 * larger. A colleague who could not open the note can ask an agent about it.
 *
 * Two things hold that line, and they are both here rather than in the UI:
 *
 *   1. `enumerate` reads the meetings AS THE KNOWLEDGE BASE'S OWNER
 *      (`transcriptionStore.listByTag` applies the same read ACL a person
 *      opening one note gets). So a source can only ever contain meetings its
 *      owner could already open — it cannot become a way to read past the
 *      note's own sharing.
 *   2. Creating one requires `manage_knowledge` (the route's gate), and the
 *      settings screen says the consequence in words before the audience is
 *      widened.
 *
 * The owner is the KB's `tenant_id`, deliberately not the person pressing
 * refresh: a scheduled pass has nobody pressing anything, and keying it on
 * whoever last touched the source would make the document set depend on who
 * that happened to be.
 *
 * ── WHAT GOES IN THE DOCUMENT ───────────────────────────────────────
 * The summary, the decisions, and — when the source asks for them — the open
 * questions. NOT the transcript. A transcript is the raw record of who said
 * what, it is long, and it is full of asides nobody meant to publish; the
 * summary is the part that was written to be read. `fields` lets an author
 * narrow that further, and the source row says which in its subline, because
 * "this knowledge base contains our meetings" is a sentence people should be
 * able to check.
 */

const supportsModes = ['manual', 'schedule', 'after_meeting'];
const defaultMode = 'after_meeting';

/** What a source may include. `summary` is always in — without it there is no document. */
const FIELDS = Object.freeze(['summary', 'decisions', 'questions', 'actions']);
const DEFAULT_FIELDS = Object.freeze(['summary', 'decisions']);

/** One pass will not enumerate more meetings than this, whatever the tag matches. */
const MAX_MEETINGS = 500;

function fieldsOf(source) {
    const raw = source?.config?.fields;
    const list = Array.isArray(raw) ? raw.filter(f => FIELDS.includes(f)) : [];
    // `summary` is not optional: a document of decisions with no context is a
    // list of sentences beginning "we agreed to" about nothing.
    const chosen = list.length > 0 ? list : [...DEFAULT_FIELDS];
    return chosen.includes('summary') ? chosen : ['summary', ...chosen];
}

/**
 * The meetings this source currently offers.
 *
 * Keyed off the KB owner's reach, not the caller's — see the header.
 */
async function enumerate(source, ctx, deps) {
    const tag = String(source?.config?.tag || '').trim();
    if (!tag) return [];

    const store = deps.transcriptionStore || require('../../../stores/transcriptionStore');
    const owner = ctx.kb?.tenant_id || null;
    if (!owner) return [];

    let orgIds = [];
    let userGroupIds = [];
    try {
        const { askerContext } = require('../askerContext');
        const asker = await askerContext(owner);
        orgIds = [...asker.orgIds];
        userGroupIds = asker.userGroups;
    } catch (_) {
        // A failed resolve NARROWS: the owner still sees their own notes and
        // anything shared with them directly, which is the safe direction.
    }

    const meetings = await store.listByTag(tag, owner, { orgIds, userGroupIds, limit: MAX_MEETINGS });
    return (meetings || []).map(m => ({
        externalId: String(m.id),
        meeting: m,
        title: m.title || 'Meeting',
        // The note's own last edit. A summary regenerated after the meeting
        // moves this, which is what makes a re-ingest happen.
        sourceModifiedAt: m.updatedAt || m.createdAt || null,
    }));
}

/**
 * Unchanged when the note has not been touched since we last read it.
 *
 * `updated_at` moves when a summary is regenerated, a decision is edited, or a
 * tag changes — every reason the document would differ. Comparing the built
 * text instead would mean building it for every meeting on every pass, which
 * is the work this check exists to avoid.
 */
function isUnchanged(item, stored) {
    if (!stored || !item?.sourceModifiedAt || !stored.source_modified_at) return false;
    return new Date(item.sourceModifiedAt).getTime() === new Date(stored.source_modified_at).getTime();
}

/**
 * Build the document for one meeting.
 *
 * Returns null when there is nothing worth storing — a meeting whose summary
 * never generated is a row with a title and no content, and an empty document
 * in a knowledge base is a search result that wastes somebody's click.
 */
async function fetch(item, stored, ctx, _deps) {
    const m = item.meeting;
    if (!m) return null;
    const fields = fieldsOf(ctx.source);

    const parts = [];
    if (fields.includes('summary') && m.summary?.trim()) parts.push(m.summary.trim());

    if (fields.includes('decisions')) {
        const lines = textsOf(m.decisions);
        if (lines.length) parts.push(`Besluiten:\n${lines.map(l => `- ${l}`).join('\n')}`);
    }
    if (fields.includes('questions')) {
        const lines = textsOf(m.questions);
        if (lines.length) parts.push(`Open vragen:\n${lines.map(l => `- ${l}`).join('\n')}`);
    }
    if (fields.includes('actions')) {
        const lines = textsOf(m.actionItems);
        if (lines.length) parts.push(`Acties:\n${lines.map(l => `- ${l}`).join('\n')}`);
    }

    const content = parts.join('\n\n').trim();
    if (!content) return null;

    return {
        content,
        title: m.title || 'Meeting',
        sourceType: 'meeting',
        sourceUri: `meeting:${m.id}`,
        sourceModifiedAt: item.sourceModifiedAt,
        metadata: {
            // The chip reads "Salesoverleg · 22 jul", so the date has to
            // travel with the document rather than being re-derived from
            // `created_at`, which is when we INGESTED it.
            meetingDate: m.createdAt || null,
            meetingId: m.id,
            tags: Array.isArray(m.tags) ? m.tags : [],
        },
    };
}

/**
 * A decision is `{ text }` in some rows and a bare string in others (the
 * shape changed and old notes were never rewritten). Both read the same to a
 * person, so both are accepted here rather than only the current one.
 */
function textsOf(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(d => (typeof d === 'string' ? d : d?.text || d?.title || ''))
        .map(s => String(s).trim())
        .filter(Boolean);
}

module.exports = { enumerate, fetch, isUnchanged, supportsModes, defaultMode, fieldsOf, textsOf, FIELDS, DEFAULT_FIELDS, MAX_MEETINGS };
