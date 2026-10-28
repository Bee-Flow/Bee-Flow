// @typecheck
/**
 * Knowledge Bases — sources (K1): creating one (POST /:id/sources). One
 * creator per kind (text, meeting tag, datatable, upload, webpage) behind the
 * shared checks (the kind is available, the plan's source cap, the refresh
 * rule). The route itself is registered in sources.js. Split out of
 * sources.js; behaviour unchanged.
 */

const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const kbStore = require('../../stores/knowledgeBases');
const kbSourcesStore = require('../../stores/kbSources');
const { getUserId, guardedFetch } = require('./shared');
const { DEFAULT_FIELDS: MEETING_DEFAULT_FIELDS } = require('../../core/kb/sources/meetingTag');
const {
    CREATABLE_KINDS, MAX_TEXT_CHARS, shapeTextOrigin, helpers, resolveKb, resolveCreators, mapSourceForApi,
    sourceForApi, maxSourcesFor, refreshPatchFor,
} = require('./sourcePolicy');
const { fallback } = require('../../utils/bestEffort');

/**
 * Fetch a page for a webpage source.
 *
 * guardedFetch first — that is the layer that screens the host AND every
 * address it resolves to, honours the operator's KB_ALLOW_PRIVATE_HOSTS
 * escape hatch and re-screens the redirect target. Only when that yields too
 * little text do we fall back to the headless browser path in
 * fetchUrlContent (which runs its own screening again), so a JS-rendered page
 * still works without giving up the guard on the normal path.
 */
async function fetchPageForSource(url) {
    const { htmlToMarkdown } = require('../../utils/htmlToMarkdown');
    let content = '';
    let title = '';
    let resolvedUrl = url;
    try {
        const response = await guardedFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);
        resolvedUrl = response.url || url;
        const body = await response.text();
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            const md = htmlToMarkdown(body, resolvedUrl, { includeLinks: true, includeImages: false });
            content = md.markdown || '';
            title = md.title || '';
            if (title && !content.startsWith(`# ${title}`)) content = `# ${title}\n\n${content}`;
        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            content = body;
        } else {
            throw new Error(`Unsupported content type: ${contentType}`);
        }
    } catch (e) {
        // Keep the reason: if the fallback also fails, this is the message worth showing.
        content = '';
        if (/private\/loopback|metadata endpoint|Only HTTP|Invalid URL/i.test(e.message)) throw e;
    }

    if (!content || content.trim().length < 20) {
        const r = await helpers().fetchUrlContent(url);
        content = r.content;
        title = r.title || title;
        resolvedUrl = r.resolvedUrl || resolvedUrl;
    }

    let hostname = url;
    try { hostname = new URL(resolvedUrl).hostname; } catch (err) { fallback('routes/knowledgeBases/sourceCreate:fetchPageForSource', err); /* keep the raw url */ }
    return { content, title: title || hostname, resolvedUrl };
}

/** text: the source and its one document are created together. */
async function createTextSource(res, { kb, name, cfg, userId, refreshPatch }) {
    const text = cfg.text;
    if (text.length > MAX_TEXT_CHARS) {
        return res.status(400).json({ error: `Text may be at most ${MAX_TEXT_CHARS} characters`, code: 'text_too_long' });
    }
    const title = String(name || cfg.title || 'Text snippet').slice(0, 200);
    const origin = shapeTextOrigin(cfg.metadata);

    /**
     * ── THE ID IS A CLAIM ABOUT A MEETING (M4) ──────────────────────
     *
     * `metadata.transcriptionId` makes this line LAND on that meeting's
     * timeline: the bar under the tag row, the Used-by tab and "Taken from
     * this transcript" all read it back, and the note's delete gate counts it
     * (core/meetingNotes/meetingUsage.js `scanKb`).
     *
     * `manage: true` is about the KNOWLEDGE BASE, and on your own knowledge
     * base you are always a manager (stores/knowledgeBases.js
     * `canUserManageKB`). Without the check below anybody could INVENT an id
     * and paste an untrue line, that cannot be refuted or removed, onto
     * someone else's meeting.
     *
     * The same guard as the `meeting_tag` branch, for the same reason: it
     * runs as the CREATOR (`askerContext`, not the knowledge base's owner),
     * and unknown NARROWS. A meeting the writer may not see gives exactly the
     * same answer as one that does not exist; otherwise this route is an
     * oracle for which meeting ids exist.
     *
     * The check sits here, in the write gate itself, before the `create`:
     * not in `shapeTextOrigin` (a shape filter a later caller can reuse
     * without asking the question), and not in the UI (not on this path).
     */
    if (origin) {
        // One gate, shared with the duplicate path: see
        // core/kb/transcriptOrigin.js for the context it runs with and why
        // `isSuperAdmin` is deliberately not in it.
        const { checkTranscriptOriginVisible } = require('../../core/kb/transcriptOrigin');
        const verdict = await checkTranscriptOriginVisible(origin.transcriptionId, userId);
        if (!verdict.ok) {
            // Not being able to look is not permission. Nothing lands.
            return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });
        }
    }

    const source = await kbSourcesStore.create({
        knowledgeBaseId: kb.id, kind: 'text', name: title,
        config: { title, charCount: text.length, ...(origin ? { metadata: origin } : {}) },
        createdBy: userId,
        ...refreshPatch,
    });
    const result = await helpers().ingestDocument(
        kb.tenant_id, kb.id, text, title, 'text', null,
        { sourceId: source.id, createdBy: userId, onFailure: 'record' },
    );
    return res.status(201).json({
        source: await sourceForApi(source, { withCounts: true }),
        document: result.document || null,
        chunks: result.chunks || 0,
        status: result.status,
    });
}

/**
 * ── meeting_tag: every meeting carrying a tag ─────────────────────────
 *
 * This source WIDENS who can read a meeting summary: putting a note in a
 * knowledge base moves it into THAT thing's audience, which may be larger.
 * Two things hold the line, and neither is in the UI: `manage: true`, so
 * only somebody who may manage this knowledge base can point it at meetings
 * at all; and the adapter enumerates as the KB's OWNER through the store's
 * own read ACL, so the source only ever contains meetings its owner could
 * already open. And the creator has to be able to see the tag themselves:
 * otherwise the choice of which meetings to expose would be made by somebody
 * who could not see them.
 */
async function createMeetingTagSource(res, { kb, name, cfg, userId, refreshPatch }) {
    const tag = cfg.tag;
    const fields = cfg.fields || [];
    // `core/kb/askerContext`, not the transcriptions routes' own resolver:
    // this is a probe, and that one hands a super admin an empty org list with
    // an `isSuperAdmin` flag the store then reads as "everything". Narrowing
    // on failure is the right direction for an access check.
    const { askerContext } = require('../../core/kb/askerContext');
    const asker = await askerContext(userId);
    let visible = [];
    try {
        visible = await require('../../stores/transcriptionStore')
            .listByTag(tag, userId, { orgIds: [...asker.orgIds], userGroupIds: asker.userGroups, limit: 1 });
    } catch (e) {
        log.warn('[KB] meeting tag probe failed:', e.message);
        throw new HttpError(502, 'tag_probe_failed', 'Could not check that tag right now.');
    }
    if (visible.length === 0) {
        // Deliberately the same answer for "no such tag" and "not yours to
        // see": distinguishing them would let somebody probe for which tags
        // exist in the organisation.
        return res.status(400).json({
            error: 'No meetings you can open carry that tag.',
            code: 'tag_not_visible',
        });
    }
    const source = await kbSourcesStore.create({
        knowledgeBaseId: kb.id, kind: 'meeting_tag',
        name: String(name || `Meetings tagged “${tag}”`).slice(0, 200),
        config: { tag, fields: fields.length ? fields : [...MEETING_DEFAULT_FIELDS] },
        createdBy: userId,
        ...refreshPatch,
    });
    return res.status(201).json({ source: await sourceForApi(source) });
}

/**
 * ── datatable: a table, live ──────────────────────────────────────────
 *
 * Same shape of risk as `meeting_tag`, and the same three defences:
 * `manage: true`; the adapter reads as the KB's OWNER through the table's own
 * row-level access filter; and the creator must be able to read the table
 * themselves, resolved here as THEM (otherwise the choice of which table to
 * expose would be made by somebody who cannot see it).
 */
async function createDatatableSource(res, { kb, name, cfg, userId, refreshPatch }) {
    const datatableId = cfg.datatableId;
    const { askerContext } = require('../../core/kb/askerContext');
    const asker = await askerContext(userId);
    let resolved;
    try {
        const { resolveDatatableForStep } = require('../../core/automationRunner/datatableResolve');
        resolved = await resolveDatatableForStep(datatableId, {
            userId,
            orgId: [...asker.orgIds][0] || null,
            userGroupIds: asker.userGroups,
        }, { needed: 'viewer' });
    } catch (e) {
        // The same answer whether the table does not exist or is not theirs:
        // telling them apart would let somebody probe for table ids.
        return res.status(400).json({
            error: 'That table is not available to you.',
            code: 'datatable_not_available',
        });
    }
    const { pickColumns } = require('../../core/kb/sources/datatable');
    const columns = pickColumns({ columns: cfg.columns }, resolved.tableMeta);
    // A column the table does not have is no title at all: the name is only
    // meaningful against the live table, so the check is here.
    const titleColumn = columns.includes(cfg.titleColumn) ? cfg.titleColumn : null;
    const source = await kbSourcesStore.create({
        knowledgeBaseId: kb.id, kind: 'datatable',
        name: String(name || resolved.table?.name || 'Table').slice(0, 200),
        config: {
            datatableId,
            tableName: resolved.table?.name || null,
            columns,
            ...(titleColumn ? { titleColumn } : {}),
        },
        createdBy: userId,
        ...refreshPatch,
    });
    // So the table's own "Used by" names this knowledge base, and deleting
    // the table asks first. Best-effort by design.
    await require('../../core/kb/sources/datatable')
        .reconcileUsage(kb.id, resolved.scope);
    return res.status(201).json({ source: await sourceForApi(source) });
}

/** upload: an empty bucket; files arrive on the next route. */
async function createUploadSource(res, { kb, name, userId, refreshPatch }) {
    const source = await kbSourcesStore.create({
        knowledgeBaseId: kb.id, kind: 'upload',
        name: String(name || 'Uploaded files').slice(0, 200),
        config: {}, createdBy: userId, ...refreshPatch,
    });
    return res.status(201).json({ source: await sourceForApi(source) });
}

/** webpage: screened fetch, then one document for the entry page. */
async function createWebpageSource(res, next, { kb, name, cfg, userId, refreshPatch }) {
    const url = cfg.url;
    const crawl = cfg.crawl || null;
    let page;
    try {
        page = await fetchPageForSource(url);
    } catch (e) {
        if (/Invalid URL|Only HTTP|private\/loopback|metadata endpoint/i.test(e.message)) {
            return res.status(400).json({ error: e.message, code: 'url_rejected' });
        }
        return next(new HttpError(502, 'fetch_failed', e.message));
    }
    const source = await kbSourcesStore.create({
        knowledgeBaseId: kb.id, kind: 'webpage',
        name: String(name || page.title || url).slice(0, 200),
        config: { url: page.resolvedUrl || url, ...(crawl ? { crawl } : {}) },
        createdBy: userId,
        ...refreshPatch,
    });
    const result = await helpers().ingestDocument(
        kb.tenant_id, kb.id, page.content, page.title, 'web', page.resolvedUrl,
        {
            sourceId: source.id, externalId: page.resolvedUrl, createdBy: userId,
            mime: 'text/html', onFailure: 'record',
        },
    );
    const counts = await kbStore.countsBySource([source.id]);
    return res.status(201).json({
        source: mapSourceForApi(source, counts[source.id], await resolveCreators([source.createdBy])),
        document: result.document || null,
        chunks: result.chunks || 0,
        status: result.status,
        // A crawl is stored, not walked: K3's refresh engine follows it.
        crawlPending: !!crawl,
    });
}

/** The plan's source cap, checked against the live count, never a stored number. */
async function assertUnderSourceLimit(res, kb, req) {
    const max = await maxSourcesFor(kb, getUserId(req));
    if (max < 0) return true;
    const current = (await kbSourcesStore.listByKb(kb.id)).length;
    if (current < max) return true;
    res.status(403).json({
        error: `This plan allows ${max} knowledge sources per knowledge base.`,
        code: 'source_limit_reached',
        limit: max,
    });
    return false;
}

/** POST /:id/sources — create one (text | upload | webpage | meeting_tag | datatable). */
async function createSource(req, res, next) {
    try {
        const kb = await resolveKb(req, res, { manage: true });
        if (!kb) return;
        const { kind, name, config, refresh } = req.body;
        if (!CREATABLE_KINDS.includes(kind)) {
            const known = kbSourcesStore.SOURCE_KINDS.includes(kind);
            return res.status(400).json({
                error: known
                    ? `Sources of kind '${kind}' cannot be created yet`
                    : `Unknown source kind '${kind}'`,
                code: 'kind_not_available',
                availableKinds: CREATABLE_KINDS,
            });
        }
        if (!(await assertUnderSourceLimit(res, kb, req))) return;

        const args = { kb, name, cfg: config, userId: getUserId(req), refreshPatch: refreshPatchFor(refresh, kind) };
        if (kind === 'text') return await createTextSource(res, args);
        if (kind === 'meeting_tag') return await createMeetingTagSource(res, args);
        if (kind === 'datatable') return await createDatatableSource(res, args);
        if (kind === 'upload') return await createUploadSource(res, args);
        return await createWebpageSource(res, next, args);
    } catch (e) {
        if (e instanceof HttpError) return next(e);
        if (e.code === 'invalid_kind' || e.code === 'invalid_refresh_mode' || e.code === 'kb_required') {
            return res.status(400).json({ error: e.message, code: e.code });
        }
        log.error('[KB] Create source error:', e.message);
        next(e);
    }
}

module.exports = { createSource };

/**
 * What every create helper receives from createSource (the body is already
 * parsed by CreateSourceBody, so `cfg` has the shape of its kind's schema).
 * @typedef {{ kb: Record<string, any>, name?: string, userId: string | null, refreshPatch: ReturnType<typeof refreshPatchFor> }} SourceArgsBase
 */
