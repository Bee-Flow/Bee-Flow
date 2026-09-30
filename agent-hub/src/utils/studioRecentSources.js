/**
 * Where each Studio section's "recently worked on" list comes from.
 *
 * Deliberately a separate module from the Studio registry
 * (components/admin/Studio/studioApps.jsx): that file is imported from App.jsx
 * and so lands in the MAIN chunk, and its top-level imports are frozen to
 * react / lazyWithReload / lucide-react by studioApps.test.jsx. Hanging fetch
 * descriptors off it would pull the API layer in with it.
 *
 * So this stays purely declarative — a URL and three field accessors per
 * section — and Sidebar.jsx does the fetching, on demand, when a section's
 * panel is first opened.
 *
 * The nine endpoints do NOT agree with each other, which is why each needs its
 * own accessor rather than one generic reader:
 *   - envelopes differ (bare array vs `{ automations }`, `{ webpages }`, …)
 *   - casing differs (raw snake_case rows for KB/agents vs camelCase mappers)
 *   - four of them ORDER BY created_at server-side while still returning the
 *     update timestamp, so ordering is done on the client either way
 *     (see rankStudioItems in studioRecents.js)
 *
 * Every source normalises to `{ id, name, description, updatedAt }`. The panel
 * prefers the description under the title — "what is this thing" beats "when
 * did it change" when you are picking one of five — and falls back to a
 * relative timestamp for the sections that carry no description.
 *
 * These are LIST endpoints, not counters: the rail's per-section counts come
 * from GET /api/studio/counts (hooks/useStudioCounts.js). Reading a count off
 * one of these lists would be wrong for Meeting Notes (capped at FETCH_LIMIT)
 * and silently empty for anyone without manage_agents.
 */

// `limit` where the endpoint honours one — the panel shows five, and ranking
// happens client-side, so a couple of dozen rows is plenty to rank over.
const FETCH_LIMIT = 25;

// Descriptions are free text and some are paragraphs. The panel is 288px wide,
// so clamp before it reaches the DOM rather than relying on line-clamp alone —
// a 2000-character agent description should not sit in the sidebar's memory,
// and an ellipsis reads better than a hard visual cut mid-word.
const DESC_MAX = 90;

/**
 * The first sentence of prose in a generated markdown summary.
 *
 * Meeting summaries open with a heading — "## 📋 Samenvatting" — and continue
 * into bullets. Clamping the raw text would put the word "Samenvatting" in
 * every single row and say nothing about the meeting. So skip the structure
 * (headings, bullets, quotes, tables, rules, bold-only lines) and take the
 * first line that is actually about something.
 */
export function firstProse(markdown) {
    if (typeof markdown !== 'string') return null;
    for (const rawLine of markdown.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // Structure, not content: headings, list items, quotes, table rows,
        // horizontal rules.
        if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||-{3,}$|\*{3,}$|_{3,}$)/.test(line)) continue;
        // A whole line of bold is a heading wearing a different hat.
        const unbolded = line.replace(/^\*\*(.+)\*\*:?$/, '$1').trim();
        if (unbolded !== line) continue;
        // Strip inline emphasis and links so the row reads as plain text.
        const plain = line
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/[*_`]/g, '')
            .trim();
        if (plain) return plain;
    }
    return null;
}

export function clampDescription(text) {
    const s = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
    if (!s) return null;
    if (s.length <= DESC_MAX) return s;
    const cut = s.slice(0, DESC_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > DESC_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The status words a recent-work row can carry — Studio Home's "Recently
 * edited" list (Track H3).
 *
 * TWO of these are not statuses at all, and keeping them apart is the whole
 * point of the vocabulary:
 *
 *   UNSUPPORTED  this section's list endpoint carries NO status field. Three
 *                of the nine are like that (knowledge, skills, solutions):
 *                `knowledge_bases` has no status column, a skill has none
 *                either, and a Solution's health lives on
 *                GET /api/projects/summary rather than on its list row. A row
 *                from one of them must not be given a green tick it did not
 *                earn — and must not be given a blank space either, which
 *                reads as "fine".
 *   UNKNOWN      the section DOES report a status and this row did not carry
 *                a readable one. A different fact, and a different sentence.
 *
 * The rest are the endpoint's own answer, folded onto one word per kind.
 * The WORDS themselves (and their colour) live with the screen that draws
 * them — components/admin/Studio/recent/recentWork.js — because this module
 * is the data adapter and must stay free of i18n and of the DOM.
 */
export const RECENT_STATUS = Object.freeze({
    UNSUPPORTED: 'unsupported',
    UNKNOWN: 'unknown',
    DRAFT: 'draft',
    PUBLISHED: 'published',
    UNPUBLISHED_CHANGES: 'unpublished_changes',
    ACTIVE: 'active',
    PAUSED: 'paused',
    FAILED: 'failed',
    PROCESSING: 'processing',
    READY: 'ready',
});

// What an accessor below may answer. UNSUPPORTED is deliberately NOT in it:
// "this kind has no status" is a property of the SECTION, decided by whether
// it declares an accessor at all, and never something one row can claim.
const ROW_STATUSES = new Set(
    Object.values(RECENT_STATUS).filter((s) => s !== RECENT_STATUS.UNSUPPORTED),
);

/**
 * `is_published` / `isPublished`, as a STRICT boolean or null.
 *
 * Not `!!row.isPublished`: an absent field would then answer "draft", which
 * is a claim about a row this client could not read. Postgres' 't'/'f' pass
 * through because /agents/all returns raw rows.
 */
const publishedFlag = (row) => {
    const v = row?.isPublished ?? row?.is_published;
    if (v === true || v === 't') return true;
    if (v === false || v === 'f') return false;
    return null;
};

/** published / draft / unknown, for the kinds whose lifecycle is exactly that. */
const publishState = (row) => {
    const flag = publishedFlag(row);
    if (flag === null) return RECENT_STATUS.UNKNOWN;
    return flag ? RECENT_STATUS.PUBLISHED : RECENT_STATUS.DRAFT;
};

/**
 * An agent's LIVE vs DRAFT, which is `published_version`, not `is_published`.
 *
 * The two are different verbs on an agent and this is the one place where
 * getting them the wrong way round is invisible: `is_published` is the SHARING
 * flag (published to the organisation), while `published_version > 0` is what
 * makes an agent live. AgentEditorHeader.test.jsx pins exactly this ("LIVE vs
 * CONCEPT hangs on published_version, not is_published — that is the other
 * publish verb"), and stores/agent/agentCrud.js:33,46 says the same on the
 * server side. Reading the sharing flag gives a live personal agent the word
 * "Draft" while its own editor header says LIVE, and an org-shared draft a
 * green "Published" — wrong in both directions, on the one word a reader has
 * to trust.
 *
 * `SELECT *` on /agents/all carries the column, so this is a read, not a guess.
 * Absent → UNKNOWN: a row this client could not read is not a draft.
 */
const agentLiveState = (row) => {
    const raw = row?.publishedVersion ?? row?.published_version;
    if (raw === null || raw === undefined || raw === '') return RECENT_STATUS.UNKNOWN;
    const n = Number(raw);
    if (!Number.isFinite(n)) return RECENT_STATUS.UNKNOWN;
    return n > 0 ? RECENT_STATUS.PUBLISHED : RECENT_STATUS.DRAFT;
};

export const STUDIO_RECENT_SOURCES = {
    // `/agents/all` — the SAME list Studio → Agents shows (AgentStudio calls it
    // too). Not the Sidebar's own `agents` prop, which comes from a different
    // query (`owner_id = you OR 'system'`) and so includes the built-in system
    // agents that Studio deliberately hides — they surfaced in this panel as
    // rows you could not find anywhere in the section they claimed to be from.
    // Requires manage_agents; a user without it simply gets no panel here.
    agents: {
        url: '/agents/all',
        pick: (d) => d, // bare array
        map: (a) => ({ id: a.id, name: a.name, description: a.description, updatedAt: a.updated_at }),
        // Raw rows, so snake_case — agentLiveState reads both spellings. And
        // it reads published_VERSION, not is_published: see the helper.
        status: agentLiveState,
    },
    skills: {
        url: '/api/skills',
        pick: (d) => d, // bare array
        map: (s) => ({ id: s.id, name: s.name, description: s.description, updatedAt: s.updatedAt }),
        // NO status accessor, deliberately: a skill row carries none. The
        // nearest thing is `lastTest` (routes/skills.js asks the store for it),
        // and "the last test passed" is not the same claim as "this skill is
        // fine" — so this section answers UNSUPPORTED and the screen says so.
    },
    knowledge: {
        url: '/api/kb',
        pick: (d) => d, // bare array
        map: (k) => ({ id: k.id, name: k.name, description: k.description, updatedAt: k.updated_at }),
        // NO status accessor: `knowledge_bases` has no status column. The list
        // does carry document counts, from which "empty" is derivable — but
        // "in error" lives on kb_sources and is not here, so a word derived
        // from half the picture would be the invented status this list must
        // not show. Emptiness that MATTERS is already a row on "Needs
        // attention" (kbEmptyInUse), where it is judged against usage.
    },
    aiTasks: {
        url: '/api/automation',
        pick: (d) => d?.automations,
        map: (a) => ({ id: a.id, name: a.title, description: a.description, updatedAt: a.updatedAt }),
        // The richest of the nine (rowToAutomation: isDraft, isActive,
        // lastStatus, lastRunAt), so the precedence is worth stating:
        //   draft   — never made live; what it did in a test run is not what
        //             a reader of this row needs to know first
        //   failed  — live and its last run errored: the actionable one
        //   paused / active — the ordinary two
        // `isActive` is read strictly: a row that carried neither true nor
        // false is unknown, not "paused".
        status: (a) => {
            if (a?.isDraft === true) return RECENT_STATUS.DRAFT;
            if (a?.lastStatus === 'error') return RECENT_STATUS.FAILED;
            if (a?.isActive === true) return RECENT_STATUS.ACTIVE;
            if (a?.isActive === false) return RECENT_STATUS.PAUSED;
            return RECENT_STATUS.UNKNOWN;
        },
    },
    webpages: {
        // `tagline` is the one-liner authors actually write for a page;
        // `description` is often the long SEO blurb.
        url: '/api/webpages',
        pick: (d) => d?.webpages,
        map: (w) => ({ id: w.id, name: w.name, description: w.tagline || w.description, updatedAt: w.updatedAt }),
        status: publishState,
    },
    // (Support used to have an entry here. It stopped being a Studio section —
    // the org-facing inbox is the Admin dashboard's — and the orphaned source
    // went with it; studioApps.test.jsx asserts the section is gone.)
    // /mine, not the shared directory: this panel is about what YOU build, and
    // the shared list is dominated by other people's published apps.
    apps: {
        url: '/api/studio-apps/mine',
        pick: (d) => d?.apps,
        map: (a) => ({ id: a.id, name: a.name, description: a.description, updatedAt: a.updatedAt }),
        // The one kind that can say "live, but the draft has moved on":
        // definitionVersion vs publishedVersion. `publishedVersion` is NULL on
        // apps published before the column existed, and mapAppMetaRow's own
        // note says callers must read that as "unknown, never as in step with
        // the draft" — so a published app whose live version is unknown stays
        // PUBLISHED here rather than being accused of unpublished changes.
        status: (a) => {
            const flag = publishedFlag(a);
            if (flag === null) return RECENT_STATUS.UNKNOWN;
            if (!flag) return RECENT_STATUS.DRAFT;
            // `Number(null)` is 0, not NaN — so the absence has to be tested
            // before the conversion, or every legacy app would report its
            // whole draft history as unpublished changes.
            const live = a?.publishedVersion == null ? NaN : Number(a.publishedVersion);
            const draft = a?.definitionVersion == null ? NaN : Number(a.definitionVersion);
            if (!Number.isFinite(live) || !Number.isFinite(draft)) return RECENT_STATUS.PUBLISHED;
            return draft > live ? RECENT_STATUS.UNPUBLISHED_CHANGES : RECENT_STATUS.PUBLISHED;
        },
    },
    // The one endpoint whose rows are not all yours: /api/datatables returns
    // every table you hold ANY grade on, so a colleague's table you can read
    // ranks here beside your own. That is right for this panel — "recently
    // worked on" for a datatable means "recently written to", and a table
    // another routine is filling is exactly the one you want to jump back to.
    datatables: {
        url: '/api/datatables',
        pick: (d) => d?.datatables,
        map: (t) => ({ id: t.id, name: t.name, description: t.description, updatedAt: t.updatedAt }),
        // NO status accessor, deliberately. `rowCount` rides along, but a row
        // count is a size, not a state: an empty table is a perfectly healthy
        // new table. And `isPublished` on a table is NOT a lifecycle — it is
        // the AUDIENCE (datatableStore setSharing: isPublished + sharedGroups
        // + writeMode), which the Tables screen itself words as "Personal" /
        // "Whole organisation" / "Shared with groups" and never as "Draft"
        // (Datatables/DatatableCard.jsx:37-40). Reading it as a lifecycle gave
        // a personal table that is written to daily the word "Draft", and a
        // shared one a green "Published" — the reassuring colour this list is
        // not allowed to invent. So tables answer UNSUPPORTED and the screen
        // says why.
    },
    // A transcript has no description, but it does have a generated summary,
    // and the opening line of that says what the meeting was about far better
    // than its date does. The list endpoint returns a 400-char prefix
    // (`summarySnippet`); the first prose line is pulled out of its markdown.
    // Falls back to the timestamp while a recording is still being processed.
    meetingNotes: {
        url: `/api/transcriptions?limit=${FETCH_LIMIT}`,
        pick: (d) => d?.transcriptions,
        map: (m) => ({
            id: m.id,
            name: m.title || m.fileName,
            description: firstProse(m.summarySnippet),
            updatedAt: m.updatedAt,
        }),
        // 'completed' | 'failed' | 'processing' (transcriptionStore.mapRow
        // defaults a NULL column to 'completed', so a missing field here means
        // the payload did not carry one at all). Anything that is neither of
        // the two settled values is still in flight — which is the honest
        // reading of a vocabulary that may gain a queue state later.
        status: (m) => {
            const s = typeof m?.status === 'string' ? m.status.trim() : '';
            if (!s) return RECENT_STATUS.UNKNOWN;
            if (s === 'failed') return RECENT_STATUS.FAILED;
            if (s === 'completed') return RECENT_STATUS.READY;
            return RECENT_STATUS.PROCESSING;
        },
    },
    playbooks: {
        url: '/api/playbooks',
        pick: (d) => d?.playbooks,
        map: (p) => ({ id: p.id, name: p.title, description: p.recipeLabel || p.recipeId, updatedAt: p.updatedAt }),
        // Playbook-level status folded onto the vocabulary: a build in a phase
        // is PROCESSING, waiting for the person's "go on" is PAUSED, complete
        // is READY, stopped is PAUSED too (the person can pick it back up).
        status: (p) => {
            const phases = Array.isArray(p?.phases) ? p.phases : [];
            if (p?.status === 'done') return RECENT_STATUS.READY;
            if (p?.status === 'stopped') return RECENT_STATUS.PAUSED;
            if (phases.some((x) => x && x.status === 'failed')) return RECENT_STATUS.FAILED;
            if (phases.some((x) => x && x.status === 'running')) return RECENT_STATUS.PROCESSING;
            if (phases.some((x) => x && x.status === 'awaiting')) return RECENT_STATUS.PAUSED;
            return p?.status === 'active' ? RECENT_STATUS.PROCESSING : RECENT_STATUS.UNKNOWN;
        },
    },
    // Solutions — /api/projects is a bare array of the projects you own or
    // are a member of (routes/projects.js GET /, projectStore.listUserProjects).
    // `kind=solution` narrows it to the Studio bundles (plus the rows from
    // before the split nobody has classified yet), which is exactly the list
    // the Solutions section shows. Collaborative project workspaces are not
    // Studio items and never appear here.
    solutions: {
        url: '/api/projects?kind=solution',
        pick: (d) => (Array.isArray(d) ? d : d?.projects),
        map: (p) => ({ id: p.id, name: p.name, description: p.description, updatedAt: p.updatedAt || p.updated_at }),
        // NO status accessor: /api/projects carries none. A Solution's health
        // is `complete` / `blocked` / `unavailable` from GET
        // /api/projects/summary, which is a second (budgeted) request and a
        // verdict with three values of its own — far too much to fold into one
        // word on a "recently edited" row, and far too easy to fold WRONGLY.
    },
};

/**
 * The status of ONE RAW row, always one of RECENT_STATUS.
 *
 *   - a section with no accessor answers UNSUPPORTED (it has no status to
 *     give, and never will from this endpoint);
 *   - a row an accessor cannot read answers UNKNOWN;
 *   - an accessor that throws or answers outside the vocabulary also answers
 *     UNKNOWN, because a screen may not print whatever a mapper happened to
 *     return.
 *
 * Takes the RAW row, not the normalised item: the status fields are exactly
 * the ones `map` throws away (the sidebar's panel needs "what is this thing",
 * not "what state is it in"), and adding them to the normalised shape would
 * change what every existing caller of normaliseRecentItems receives.
 */
export function recentStatusOf(sectionId, row) {
    const source = STUDIO_RECENT_SOURCES[sectionId];
    if (!source) return RECENT_STATUS.UNSUPPORTED;
    if (typeof source.status !== 'function') return RECENT_STATUS.UNSUPPORTED;
    if (!row || typeof row !== 'object') return RECENT_STATUS.UNKNOWN;
    let code = null;
    try {
        code = source.status(row);
    } catch {
        return RECENT_STATUS.UNKNOWN;
    }
    return ROW_STATUSES.has(code) ? code : RECENT_STATUS.UNKNOWN;
}

/** Normalise already-extracted rows into `{ id, name, description, updatedAt }[]`. */
export function normaliseRecentRows(sectionId, rows) {
    const source = STUDIO_RECENT_SOURCES[sectionId];
    if (!source || !Array.isArray(rows)) return [];
    return rows
        .map(source.map)
        .filter((item) => item && item.id)
        .map((item) => ({ ...item, description: clampDescription(item.description) }));
}

/** Normalise one endpoint payload into `{ id, name, description, updatedAt }[]`. */
export function normaliseRecentItems(sectionId, payload) {
    const source = STUDIO_RECENT_SOURCES[sectionId];
    if (!source) return [];
    return normaliseRecentRows(sectionId, source.pick ? source.pick(payload) : payload);
}

export default STUDIO_RECENT_SOURCES;
