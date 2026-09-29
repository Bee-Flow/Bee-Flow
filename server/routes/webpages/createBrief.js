/**
 * Wat de bouwbalk meestuurt bij POST /, gecontroleerd en omgezet in een brief.
 *
 * De route (./crud.js) parseert, autoriseert en serialiseert; het wegen van de
 * gekozen bronnen — bestaat hij, mag DEZE beller erbij, hoe heet hij volgens de
 * server — en het schrijven van de brief die de AI elke beurt leest, gebeurt
 * hier.
 */

/* ── Describe-to-build create (Webpages artboard 1a, plan W1) ──────────
 *
 * `POST /` takes `{ name?, prompt, sources }`. The overview's build bar sends
 * a BRIEF and the sources it should read; the name-only shortcut (now under
 * "All options") sends just a name and is the same request with no prompt.
 *
 * Two rules hold this together:
 *   1. `create_webpage` from integrations/webpageBuilderTools.js is the ONE
 *      implementation of "what a new page is" — the same call the AI makes in
 *      a normal chat. This route adds only what a chat-created page has no
 *      concept of: the framework/runtime tier and the build brief.
 *   2. Every source is verified for THIS caller BEFORE the page is created.
 *      A refused source must not leave an orphan page behind, and a source id
 *      is never trusted because the client sent it back.
 */

/** The kinds "Bron kiezen" can name. An allow-list: anything else is a 400. */
const CREATE_SOURCE_KINDS = new Set(['datatable', 'automation']);
const MAX_CREATE_SOURCES = 10;
const MAX_PROMPT_CHARS = 4000;
const DERIVED_NAME_MAX = 60;

function badRequest(status, message, code) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

/**
 * `{ kind, id }` pairs and nothing else. Built field by field rather than by
 * spreading the request entry, so a key the client adds later cannot ride
 * along into a grant or a prompt.
 */
function normalizeCreateSources(raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw badRequest(400, 'sources must be an array');
    if (raw.length > MAX_CREATE_SOURCES) throw badRequest(400, `At most ${MAX_CREATE_SOURCES} sources`);
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') throw badRequest(400, 'Each source must be an object');
        const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!CREATE_SOURCE_KINDS.has(kind)) throw badRequest(400, `Unknown source kind: ${kind || '(none)'}`);
        if (!id) throw badRequest(400, 'Each source needs an id');
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, id });
    }
    return out;
}

/**
 * A page name from the brief. First line, first sentence, cut on a word
 * boundary — the name is renameable in one click, so a readable guess beats
 * both "Untitled Webpage" and a 200-character title.
 */
function deriveNameFromPrompt(prompt) {
    if (typeof prompt !== 'string') return '';
    const firstLine = prompt.split('\n').map(s => s.trim()).find(Boolean) || '';
    const sentence = firstLine.split(/(?<=[.!?])\s/)[0] || firstLine;
    const clean = sentence.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    if (clean.length <= DERIVED_NAME_MAX) return clean;
    const cut = clean.slice(0, DERIVED_NAME_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Verify each picked source for the CALLER, and answer with the server's own
 * name for it (never the client's). Automations must be the caller's own —
 * the same rule webpageGrants.grantAutomation enforces when the grant is
 * written a moment later. Tables must grade at least `viewer` through the one
 * resolver the datatable API and the runner share, looked up scope by scope
 * so a table the caller holds no grade on is not even probeable (404).
 */
async function resolveCreateSources(req, sources) {
    if (!sources.length) return [];
    const userId = req.session.user.id;
    const resolved = [];

    const automationIds = sources.filter(s => s.kind === 'automation').map(s => s.id);
    const automationById = new Map();
    if (automationIds.length) {
        const automationStore = require('../../stores/automationStore');
        for (const id of automationIds) {
            const a = await automationStore.getAutomation(id).catch(() => null);
            if (!a) throw badRequest(404, `Automation ${id} not found`);
            if (a.userId !== userId) throw badRequest(403, 'You can only build on your own automations');
            automationById.set(id, a);
        }
    }

    const tableIds = sources.filter(s => s.kind === 'datatable').map(s => s.id);
    const tableById = new Map();
    if (tableIds.length) {
        const datatableStore = require('../../stores/datatableStore');
        const {
            resolveDatatablePrincipal, datatableScopesFor, gradeForPrincipal, gradeAtLeast,
        } = require('../../auth/datatableAccess');
        const principal = await resolveDatatablePrincipal(req);
        const scopes = datatableScopesFor(principal);
        for (const id of tableIds) {
            let table = null;
            for (const scope of scopes) {
                table = await datatableStore.getDatatable(id, scope);
                if (table) break;
            }
            if (!table) throw badRequest(404, 'Table not found');
            const grants = await datatableStore.listGrants(table.id);
            const grade = gradeForPrincipal(table, grants, principal);
            // No grade is NOT FOUND on purpose: "someone else's" and "deleted"
            // must not be distinguishable (routes/datatables.js).
            if (!grade) throw badRequest(404, 'Table not found');
            if (!gradeAtLeast(grade, 'viewer')) throw badRequest(403, 'This needs viewer access to the datatable');
            tableById.set(id, table);
        }
    }

    for (const s of sources) {
        const found = s.kind === 'automation' ? automationById.get(s.id) : tableById.get(s.id);
        resolved.push({ kind: s.kind, id: s.id, name: String(found?.title || found?.name || s.id) });
    }
    return resolved;
}

/**
 * The brief the AI reads on every turn of this page's chat — it lands in
 * `instructions`, which webpageChat renders as "Custom instructions from the
 * user". The sources are named here rather than left implicit so the first
 * turn already knows what it is building against.
 */
function buildBrief(prompt, sources) {
    if (!prompt) return '';
    if (!sources.length) return prompt;
    const lines = sources.map(s => (s.kind === 'automation'
        ? `- Automation "${s.name}" (id ${s.id})`
        : `- Table "${s.name}" (id ${s.id})`));
    return `${prompt}\n\nSources the author picked for this page:\n${lines.join('\n')}`;
}

module.exports = {
    CREATE_SOURCE_KINDS,
    MAX_CREATE_SOURCES,
    MAX_PROMPT_CHARS,
    DERIVED_NAME_MAX,
    badRequest,
    normalizeCreateSources,
    deriveNameFromPrompt,
    resolveCreateSources,
    buildBrief,
};
