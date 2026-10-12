/**
 * Fixtures for the Knowledge bases (kennisbank) demo.
 *
 * Seven knowledge bases across four categories, with realistic document
 * counts, and one of them — Product documentation — filled in far enough that
 * opening it shows the real Studio detail: its sources, what each source
 * pulled in, the document rows with their status, and a test question that
 * comes back with cited passages.
 *
 * Studio shows no chunk counts and no chunk text (K2 removed both), so
 * nothing here is FOR them; `chunk_count` and the split-on-blank-lines
 * passages survive because the retrieval routes below still speak in
 * passages, which is what a citation is.
 *
 * The bases are named after the kinds of material an organisation actually
 * indexes — policies, product documentation, tender history, Dutch legal
 * sources — but the documents are invented and no real content is included.
 *
 * TWO TRAPS THIS FILE EXISTS TO AVOID, both of which shipped:
 *
 * 1. ICONS ARE EMOJI, NOT LUCIDE NAMES. KnowledgeStudio no longer renders
 *    `kb.icon` at all — every base wears the shared `kb` kind tile — but the
 *    categories panel and the chat-side pickers still print the value as
 *    TEXT. The fixture used to supply Lucide component names ('BookOpen',
 *    'ShieldCheck'), so the sidebar literally read "BookOpen Employee
 *    handbook". Keep them emoji.
 *
 * 2. THE LIST AND THE DETAIL VIEW ARE DIFFERENT ENDPOINTS. The list comes
 *    from `GET /api/kb`, but opening a base calls `GET /api/kb/:id` — which
 *    the fixture did not answer. The transport failed closed with a 404 and
 *    the detail turned that into "Knowledge base not found". A full list next
 *    to that message is worse than no demo.
 *
 * 3. AND SO IS EVERY SOURCE ROUTE. The Studio opens on the Sources tab, which
 *    calls `GET /api/kb/:id/sources` and then `…/sources/:sid/documents`. An
 *    unfixtured route is the same silent 404, on the FIRST screen this time,
 *    so both are answered below — including the per-source counters the
 *    filter chips count from, which must add up to `documentCount` or the
 *    chips contradict the table beneath them.
 *
 * Route ORDER matters here: `GET /api/kb/categories` must be declared before
 * `GET /api/kb/:id` or the matcher (first match wins) resolves "categories"
 * as an id.
 */

import { COMMON_ROUTES, daysAgo } from './common';

const ORG = 'org_demo_vandael';

const CATEGORIES = () => ([
    { id: 'kbc_internal', name: 'Internal', icon: '🏢' },
    { id: 'kbc_product', name: 'Product', icon: '📦' },
    { id: 'kbc_commercial', name: 'Commercial', icon: '🤝' },
    { id: 'kbc_legal', name: 'Legal & compliance', icon: '⚖️' },
]);

/**
 * One document row as the detail view reads it: `title`, `source_type` (drives
 * the emoji), `chunk_count` and `created_at`. `content` is not part of the
 * server's row — it is here so the chunks endpoint below can cut real text
 * instead of lorem.
 *
 * `chunk_count` is DERIVED from that text, and the KB's `document_count` and
 * `total_chunks` are derived from the documents, because the detail view puts
 * the count and the list on the same screen: a header reading "212 documents"
 * above eight rows, or "28 chunks" above two, is a number the visitor can see
 * is wrong. Same rule the monitoring fixture follows.
 */
const doc = (id, title, source_type, ageDays, content) => ({
    id, title, source_type,
    chunk_count: splitChunks(content).length,
    created_at: daysAgo(ageDays),
    content,
});

/** One chunk per paragraph — the split the chunks endpoint below also uses. */
const splitChunks = (text) => String(text || '').split(/\n\n+/).filter(Boolean);

const PRODUCT_DOCS = () => ([
    doc('kbd_install', 'Installation guide — self-hosted', 'upload', 12,
        'Bee Flow runs as a set of containers behind a single reverse proxy. The minimum profile is the API, the frontend and PostgreSQL with pgvector; the guard, reranker and transcription services are optional profiles you enable when you need them.\n\nThe installer provisions three databases and writes a key file that is never transmitted. Back that file up before you take the stack into production: without it, envelope-encrypted content cannot be recovered.'),
    doc('kbd_models', 'Configuring model providers', 'upload', 12,
        'A provider is configured once per organisation and then referenced by tier. Anthropic, OpenAI, Google, Google Vertex, Azure OpenAI and Mistral have first-party adapters; anything else that speaks the OpenAI chat-completions protocol can be added as a custom endpoint, including a model running on your own hardware.\n\nTiers exist so a change of provider does not mean editing every assistant. Point the "balanced" tier somewhere else and every assistant that asked for "balanced" follows.'),
    doc('kbd_rag', 'How retrieval works', 'upload', 26,
        'A document is split into chunks at semantic boundaries rather than at a fixed character count, embedded, and stored with its source reference. At query time the question is embedded, the nearest chunks are retrieved, and a cross-encoder re-ranks them before any of it reaches a model.\n\nEvery answer carries the chunks it used. An answer with no retrievable source is reported as such instead of being written anyway.'),
    doc('kbd_privacy', 'Privacy Shield reference', 'upload', 40,
        'The shield inspects a message after it leaves the browser and before it reaches a provider. Detected values are replaced with placeholders of the form [email_1]; the mapping is held for the duration of the request and used to restore the real values in the reply.\n\nWhen the detector cannot be reached the shield fails closed by default: the message is not sent.'),
    doc('kbd_release', 'Upgrade and rollback', 'web', 55,
        'Images are tagged per channel. An upgrade is a pull and a recreate; migrations run on boot and are idempotent. Roll back by pinning the previous tag — the schema is forward-compatible within a minor version.'),
    doc('kbd_api', 'API reference — agents and automations', 'web', 61,
        'Every surface in the product is an HTTP API with the same authentication and the same permission model. An automation step that calls the API is subject to the caller\'s grants, not the automation author\'s.'),
    doc('kbd_faq', 'Frequently asked questions', 'text', 74,
        'Does an assistant see documents the person asking cannot open? No. Retrieval is filtered by the same audience rules that govern the knowledge base itself, before the model is called.'),
    doc('kbd_glossary', 'Glossary', 'text', 74,
        'Assistant — a configured model with instructions, skills and knowledge. Automation — a saved sequence of steps that can run on a trigger. Skill — reusable instructions an assistant pulls in on demand.'),
]);

const HANDBOOK_DOCS = () => ([
    doc('kbd_hb_leave', 'Leave and absence', 'upload', 92, 'Statutory leave accrues per calendar year. Requests go to your team lead; absence is reported before 09:00 on the first day.'),
    doc('kbd_hb_expenses', 'Expenses and travel', 'upload', 92, 'Second-class rail is the default for domestic travel. Receipts are submitted within thirty days.'),
    doc('kbd_hb_conduct', 'Code of conduct', 'upload', 130, 'The confidential adviser can be approached directly and without involving your manager.'),
]);

const GENERIC_DOCS = (prefix, subject) => ([
    doc(`${prefix}_1`, 'Overview', 'upload', 44,
        `An overview of ${subject}. Sample content only — the point of this base in the demo is that it exists, is categorised, and is reachable.`),
    doc(`${prefix}_2`, 'Reference', 'upload', 70,
        `Reference material for ${subject}. Sample content only.`),
]);

const KBS = () => ([
    {
        id: 'kb_demo_handbook', name: 'Employee handbook', icon: '📕',
        description: 'HR policies, leave, expenses and the code of conduct.',
        category_id: 'kbc_internal',
        documents: HANDBOOK_DOCS(),
    },
    {
        id: 'kb_demo_itpolicy', name: 'IT and security policies', icon: '🛡️',
        description: 'Acceptable use, access control, incident response.',
        category_id: 'kbc_internal',
        documents: GENERIC_DOCS('kbd_it', 'the IT and security policy set'),
    },
    {
        id: 'kb_demo_productdocs', name: 'Product documentation', icon: '📘',
        description: 'Everything the product ships with: installation, configuration, retrieval, the API.',
        category_id: 'kbc_product',
        documents: PRODUCT_DOCS(),
    },
    {
        id: 'kb_demo_releasenotes', name: 'Release notes archive', icon: '🗒️',
        description: 'Every release note since the first public build.',
        category_id: 'kbc_product',
        documents: GENERIC_DOCS('kbd_rel', 'the release history'),
    },
    {
        id: 'kb_demo_tenders', name: 'Tender answer library', icon: '📋',
        description: 'Answers written for earlier tenders, reusable with review.',
        category_id: 'kbc_commercial',
        documents: GENERIC_DOCS('kbd_tnd', 'previously submitted tender answers'),
    },
    {
        id: 'kb_demo_contracts', name: 'Standard contract positions', icon: '🖋️',
        description: 'Fallback positions per clause, with the reasoning behind them.',
        category_id: 'kbc_legal',
        documents: GENERIC_DOCS('kbd_con', 'standard contract positions'),
    },
    {
        id: 'kb_demo_dutchlaw', name: 'Nederlandse juridische bronnen', icon: '🏛️',
        description: 'Wetteksten en jurisprudentie, met bronvermelding.',
        category_id: 'kbc_legal',
        documents: GENERIC_DOCS('kbd_nl', 'Nederlandse wetteksten en jurisprudentie'),
    },
].map(kb => ({
    ...kb,
    organization_id: ORG,
    is_published: true,
    // Counted, never typed. The sidebar badge, the "N documents · M chunks"
    // header and the list underneath it are all on screen at once.
    document_count: kb.documents.length,
    doc_count: kb.documents.length,
    total_chunks: kb.documents.reduce((s, d) => s + d.chunk_count, 0),
    // A JSON STRING, not an array — and still parsed as one today by the
    // composer's knowledge picker (components/chat/InputArea.jsx:1056 does
    // JSON.parse on it when it is a string). Changing it to [] here would
    // make the fixture disagree with the one screen that still reads it.
    shared_groups: '[]',
    usage_contexts: ['agent', 'direct_chat'],
})));

/**
 * The list must not carry the document bodies — the real endpoint doesn't —
 * and it DOES carry the counters the overview's freshness cell reads.
 */
const listRow = ({ documents, ...rest }) => {
    const sources = sourcesFor({ id: rest.id, documents });
    return {
        ...rest,
        sourceCount: sources.length,
        autoRefreshCount: sources.filter(x => x.refreshMode !== 'manual').length,
        documentCount: documents.length,
        documentCountAll: documents.length,
        totalChunks: documents.reduce((n, d) => n + d.chunk_count, 0),
        lastContentAt: documents[0]?.created_at || null,
    };
};

/**
 * Chunks for a document: the real endpoint returns pre-split passages, so the
 * demo splits the document text on blank lines rather than inventing chunk
 * text that says nothing.
 */
const chunksFor = (document) => splitChunks(document.content)
    .map((content, i) => ({ chunk_id: i, chunk_type: 'content', lang: 'en', content }));

/**
 * The SOURCES of a base, derived from the documents it already holds.
 *
 * Derived rather than typed, for the same reason the counts are: the Sources
 * tab's summary line, the per-source document counts and the document table
 * are all on one screen, and three hand-written numbers drift apart the
 * first time someone edits a document out of the list above.
 *
 * `source_type` on a document is the pre-source-model field ('upload',
 * 'web', 'text'), which is exactly what the real backfill migration groups
 * by — so the demo's shape is the shape a real install gets on upgrade.
 */
const SOURCE_KIND_FOR = { upload: 'upload', web: 'webpage', text: 'text' };
const SOURCE_NAME_FOR = {
    upload: 'Uploaded files',
    webpage: 'Documentation site',
    text: 'Pasted notes',
};
const SOURCE_REFRESH_FOR = {
    upload: { refreshMode: 'manual', refreshCron: null },
    webpage: { refreshMode: 'schedule', refreshCron: '0 6 * * 1' },
    text: { refreshMode: 'manual', refreshCron: null },
};

function sourcesFor(kb) {
    const byKind = new Map();
    for (const d of kb.documents || []) {
        const kind = SOURCE_KIND_FOR[d.source_type] || 'legacy';
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind).push(d);
    }
    return [...byKind.entries()].map(([kind, docs]) => ({
        id: `${kb.id}__src_${kind}`,
        kind,
        name: SOURCE_NAME_FOR[kind] || 'Imported',
        config: kind === 'webpage' ? { url: 'https://docs.example.com' } : {},
        ...SOURCE_REFRESH_FOR[kind],
        refreshTz: 'Europe/Amsterdam',
        nextRefreshAt: null,
        lastRefreshAt: docs[0]?.created_at || null,
        status: 'idle',
        error: null,
        consecutiveErrors: 0,
        // Every counter a Number, as the real route promises. One document
        // per base is deliberately SKIPPED so the "Overgeslagen" chip has
        // something behind it — a demo where nothing ever fails teaches that
        // nothing ever fails.
        documentCount: docs.length,
        processedCount: docs.length - (kind === 'upload' && docs.length > 2 ? 1 : 0),
        redactedCount: 0,
        skippedCount: kind === 'upload' && docs.length > 2 ? 1 : 0,
        errorCount: 0,
        duplicateCount: 0,
        piiFoundCount: 0,
        totalChunks: docs.reduce((n, d) => n + d.chunk_count, 0),
        createdBy: { id: 'u_demo', name: 'Tessa' },
        createdAt: docs[docs.length - 1]?.created_at || null,
        updatedAt: docs[0]?.created_at || null,
    }));
}

/** The document rows a source answers with — projected, never `content`. */
function sourceDocuments(kb, source) {
    const kind = source.kind;
    const docs = (kb.documents || []).filter(d => (SOURCE_KIND_FOR[d.source_type] || 'legacy') === kind);
    return docs.map((d, i) => ({
        id: d.id,
        title: d.title,
        source_type: d.source_type,
        source_uri: null,
        chunk_count: d.chunk_count,
        source_id: source.id,
        // The one skipped row per upload source, with the REASON — a status
        // with no reason is a dead end for whoever has to fix it.
        status: source.skippedCount && i === docs.length - 1 ? 'skipped' : 'processed',
        status_reason: source.skippedCount && i === docs.length - 1 ? 'No readable text found' : null,
        external_id: null,
        size_bytes: null,
        page_count: d.source_type === 'upload' ? 4 + (i % 9) : null,
        sheet_count: null,
        mime: d.source_type === 'upload' ? 'application/pdf' : 'text/html',
        pii_status: 'none',
        pii_categories: null,
        overlaps_document_id: null,
        extract_summary: null,
        created_by: 'u_demo',
        created_at: d.created_at,
        updated_at: d.created_at,
        source_modified_at: d.created_at,
    }));
}

export function createState() {
    return { kbs: KBS(), categories: CATEGORIES() };
}

const findKb = (state, id) => state.kbs.find(k => k.id === id) || null;

/**
 * Who uses a base. ONE function, two routes: the Used-by tab asks per base
 * (`/:id/usage`) and the overview asks for all of them at once
 * (`/usage-summary`). Two hand-written answers to the same question disagree
 * the first time one of them is edited, and the overview pill and the tab
 * beneath it are two clicks apart.
 */
function usageFor(kb) {
    if (!kb) return [];
    // The product base is the one the demo's agents actually cite.
    return kb.id === 'kb_demo_productdocs'
        ? [
            { kind: 'agent', id: 'ag_demo_support', title: 'Support assistant', role: 'chat', lastAt: daysAgo(1) },
            { kind: 'agent', id: 'ag_demo_onboarding', title: 'Onboarding buddy', role: 'chat', lastAt: daysAgo(6) },
            { kind: 'skill', id: 'sk_demo_answer', title: 'Answer from the docs', role: 'contains' },
        ]
        : [];
}

/**
 * A real 404, not `null`. `null` becomes 204 No Content in the transport,
 * which a caller reads as "it exists and is empty" — the opposite claim.
 */
const notFoundDoc = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

/** An SSE response the way `readNamedSse` in knowledgeApi.js reads it. */
function sse(frames) {
    const text = frames.map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`).join('');
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export const ROUTES = {
    ...COMMON_ROUTES,

    // The Studio accepts either a bare array or `{ kbs }`; the bare array is
    // what the real endpoint returns, so that is what the demo returns too.
    'GET /api/kb': ({ state }) => state.kbs.map(listRow),

    // BEFORE the `:id` route — first match wins, and "categories" is not an id.
    'GET /api/kb/categories': ({ state }) => state.categories,
    'GET /api/kb/n8n/ingestible': () => ([]),

    /**
     * The overview's two chrome routes — ALSO before `:id`, and for a nastier
     * reason than "categories": these two fail SILENTLY without this line.
     * `:param` matches exactly one segment, so `GET /api/kb/:id` swallows
     * `/api/kb/usage-summary`, `findKb` answers null, and index.jsx turns
     * that into `usageByKb = {}` — "loaded, nothing uses anything" — where a
     * real failure would have left it null and drawn nothing. That is the
     * exact distinction the comment there guards ("draw nothing rather than
     * 'used by nothing'"), inverted by a route table.
     */
    'GET /api/kb/usage-summary': ({ state }) => ({
        summary: Object.fromEntries(state.kbs.map((kb) => {
            const counts = {};
            for (const u of usageFor(kb)) counts[u.kind] = (counts[u.kind] || 0) + 1;
            // `partial` is "kinds I could not check". The demo checks
            // everything it knows about, so it is empty — never omitted,
            // because a missing field reads as the same thing by accident.
            return [kb.id, { counts, partial: [] }];
        })),
    }),
    /**
     * No nudge in the demo, on purpose. A suggestion's "Link them" button
     * PATCHes a real agent (index.jsx acceptSuggestion), and the knowledge
     * demo ships no agents to patch — so an offer here would be one the
     * visitor cannot take. An empty list is "nothing to suggest", which is
     * true, and it is a LOADED answer: the banner stays away rather than the
     * screen claiming the check failed.
     */
    'GET /api/kb/suggestions': () => ({ suggestions: [] }),

    // Sources BEFORE the `:id` detail, the same order the server mounts them
    // in: `/:id/sources/...` must never be reached through a detail handler.
    'GET /api/kb/:id/sources': ({ state, params }) => {
        const kb = findKb(state, params.id);
        const sources = kb ? sourcesFor(kb) : [];
        const sum = (k) => sources.reduce((n, x) => n + (x[k] || 0), 0);
        return {
            sources,
            totals: {
                sourceCount: sources.length,
                autoRefreshCount: sources.filter(x => x.refreshMode !== 'manual').length,
                errorSourceCount: 0,
                documentCount: sum('documentCount'),
                processedCount: sum('processedCount'),
                redactedCount: 0,
                skippedCount: sum('skippedCount'),
                errorCount: 0,
                duplicateCount: 0,
                piiFoundCount: 0,
                totalChunks: sum('totalChunks'),
            },
        };
    },
    'GET /api/kb/:id/sources/:sid/documents': ({ state, params, query }) => {
        const kb = findKb(state, params.id);
        const source = kb ? sourcesFor(kb).find(x => x.id === params.sid) : null;
        if (!kb || !source) return { documents: [], total: 0, limit: 50, offset: 0 };
        let documents = sourceDocuments(kb, source);
        // The filter chips send `status` and `pii`; a fixture that ignored
        // them would show every chip returning the same rows, which is the
        // one thing the chips are there to disprove.
        const status = String(query?.status || '').split(',').filter(Boolean);
        if (status.length) documents = documents.filter(d => status.includes(d.status));
        if (query?.pii === 'found') documents = documents.filter(d => d.pii_status === 'found' || d.pii_status === 'redacted');
        const q = String(query?.q || '').toLowerCase();
        if (q) documents = documents.filter(d => d.title.toLowerCase().includes(q));
        return { documents, total: documents.length, limit: 50, offset: 0 };
    },

    /**
     * Who uses this base. K5 lands the real endpoint; the demo answers it
     * now because the Used-by tab asks on every open, and an unfixtured
     * route is a silent 404 the tab renders as "could not load".
     */
    'GET /api/kb/:id/usage': ({ state, params }) => ({ usage: usageFor(findKb(state, params.id)) }),

    /**
     * One document row, by id. Same projection the list answers with, so the
     * detail cannot disagree with the row it was opened from.
     */
    'GET /api/kb/:id/sources/:sid/documents/:docId': ({ state, params }) => {
        const kb = findKb(state, params.id);
        const source = kb ? sourcesFor(kb).find(x => x.id === params.sid) : null;
        if (!kb || !source) return notFoundDoc();
        return sourceDocuments(kb, source).find(d => d.id === params.docId) || notFoundDoc();
    },

    'GET /api/kb/:id': ({ state, params }) => findKb(state, params.id),
    'GET /api/kb/:id/documents': ({ state, params }) => (findKb(state, params.id)?.documents || []),
    /**
     * The ONE route that returns a document BODY (`{ document, content,
     * remote_only }`). `remote_only` false: the demo holds the text itself,
     * so there is nothing to go and fetch.
     */
    'GET /api/kb/:id/documents/:docId/content': ({ state, params }) => {
        const kb = findKb(state, params.id);
        const d = (kb?.documents || []).find(x => x.id === params.docId);
        if (!d) return notFoundDoc();
        return {
            document: { id: d.id, title: d.title, source_type: d.source_type, chunk_count: d.chunk_count, created_at: d.created_at },
            content: d.content,
            remote_only: false,
        };
    },
    'GET /api/kb/:id/documents/:docId/chunks': ({ state, params }) => {
        const d = (findKb(state, params.id)?.documents || []).find(x => x.id === params.docId);
        return { chunks: d ? chunksFor(d) : [], remote_only: false };
    },

    /**
     * Retrieval, honestly labelled. The product embeds the question and
     * re-ranks with a cross-encoder; this scores by term overlap so the demo
     * can run with no network and no model. What is real is the SHAPE of an
     * answer: a passage, the document it came from, and a score — the point
     * being that an answer here always carries its source.
     */
    'POST /api/kb/search': ({ state, body }) => {
        const query = String(body?.query || '').toLowerCase();
        const terms = query.split(/\W+/).filter(w => w.length > 3);
        const ids = Array.isArray(body?.kb_ids) ? body.kb_ids : [];
        const pool = state.kbs.filter(k => !ids.length || ids.includes(k.id));
        const scored = [];
        for (const kb of pool) {
            for (const d of kb.documents || []) {
                for (const c of chunksFor(d)) {
                    const hay = c.content.toLowerCase();
                    const hits = terms.filter(term => hay.includes(term)).length;
                    if (!hits) continue;
                    scored.push({
                        id: `${d.id}#${c.chunk_id}`,
                        document_id: d.id,
                        chunk_id: c.chunk_id,
                        title: d.title,
                        source_uri: `${kb.name} · ${d.title}`,
                        score: Math.min(0.99, 0.42 + hits * 0.17),
                        content: c.content,
                    });
                }
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return { chunks: scored.slice(0, body?.top_k || 8) };
    },

    /**
     * The test question (K6). SSE, not JSON: knowledgeApi.ask reads named
     * frames off `response.body`, so the fixture answers with a real stream.
     *
     * `kb_sources` FIRST — the citations are on screen while the answer is
     * still arriving, which is the whole point of the panel — then the answer
     * in a few `text` frames so it visibly streams rather than appearing whole.
     * The answer is assembled from the passages that were actually found; it
     * is not a written-out reply pretending a model ran.
     */
    'POST /api/kb/:id/ask': ({ state, params, body }) => {
        const kb = findKb(state, params.id);
        const question = String(body?.question || '');
        if (!kb) return sse([['error', { error: 'Knowledge base not found' }]]);
        const terms = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        const passages = [];
        for (const d of kb.documents || []) {
            for (const c of chunksFor(d)) {
                const hits = terms.filter(term => c.content.toLowerCase().includes(term)).length;
                if (!hits) continue;
                passages.push({
                    chunkId: `${d.id}#${c.chunk_id}`,
                    documentId: d.id,
                    title: d.title,
                    sourceName: SOURCE_NAME_FOR[SOURCE_KIND_FOR[d.source_type]] || null,
                    page: d.source_type === 'upload' ? 1 + (c.chunk_id % 4) : null,
                    score: Math.min(0.99, 0.42 + hits * 0.17),
                    content: c.content,
                });
            }
        }
        passages.sort((a, b) => b.score - a.score);
        const top = passages.slice(0, 5);
        // Nothing found is an ANSWER, not an error: the card has a state for
        // it (`kb-ask-empty`) and it is the honest reply to a question this
        // base has nothing about.
        if (top.length === 0) return sse([['kb_sources', { sources: [] }], ['done', {}]]);
        const answer = top[0].content.trim().slice(0, 320);
        return sse([
            ['kb_sources', { sources: top }],
            ['text', { text: answer.slice(0, Math.ceil(answer.length / 2)) }],
            ['text', { text: answer.slice(Math.ceil(answer.length / 2)) }],
            ['done', {}],
        ]);
    },

    'POST /api/kb': ({ state, body }) => {
        const created = {
            id: `kb_demo_new_${state.kbs.length + 1}`,
            name: body?.name || 'New knowledge base',
            icon: body?.icon || '📚',
            description: body?.description || '',
            category_id: body?.category_id || null,
            organization_id: ORG,
            is_published: false,
            shared_groups: '[]',
            usage_contexts: ['agent', 'direct_chat'],
            document_count: 0,
            doc_count: 0,
            total_chunks: 0,
            documents: [],
        };
        state.kbs.push(created);
        return created;
    },

    // Both verbs: the Studio renames with PATCH, the older chat-side detail
    // still sends PUT.
    'PUT /api/kb/:id': ({ state, params, body }) => {
        const kb = findKb(state, params.id);
        if (kb) Object.assign(kb, body || {});
        return kb || {};
    },

    'PATCH /api/kb/:id': ({ state, params, body }) => {
        const kb = findKb(state, params.id);
        if (kb) Object.assign(kb, body || {});
        return kb || {};
    },

    'PATCH /api/kb/:id/publish': ({ state, params, body }) => {
        const kb = findKb(state, params.id);
        if (kb) {
            kb.is_published = !!body?.isPublished;
            if (body?.sharedGroups !== undefined) kb.shared_groups = JSON.stringify(body.sharedGroups || []);
        }
        return { success: true, kb: kb || {} };
    },

    'DELETE /api/kb/:id': ({ state, params }) => {
        const i = state.kbs.findIndex(k => k.id === params.id);
        if (i >= 0) state.kbs.splice(i, 1);
        return { ok: true };
    },

    'POST /api/kb/categories': ({ state, body }) => {
        const created = {
            id: `kbc_demo_new_${state.categories.length + 1}`,
            name: body?.name || 'New category',
            icon: body?.icon || '📁',
        };
        state.categories.push(created);
        return created;
    },
};
