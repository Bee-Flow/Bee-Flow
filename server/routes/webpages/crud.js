// @typecheck
/**
 * ── Webpage CRUD ──────────────────────────────────────────────────
 *
 * De pagina zelf: maken, opsommen, openen, opslaan.
 *
 * POST /  ·  GET /  ·  GET /:id  ·  PUT /:id
 */

const webpageStore = require('../../stores/webpageStore');
const publicShareStore = require('../../stores/webpagePublicShareStore');
const { resolveAudienceContext } = require('../../auth/audience');
const { requireAuth } = require('../../auth/permissions');
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');
const versionFacts = require('../../core/webpages/versionFacts');
const { readSlotsForReader } = require('./publishedSnapshot');
const { reSnapshotWebpageShares } = require('./publicShares');
const {
    MAX_PROMPT_CHARS,
    normalizeCreateSources,
    deriveNameFromPrompt,
    resolveCreateSources,
    buildBrief,
} = require('./createBrief');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded, bodyOf, choice, idList, NO_QUERY } = require('./schemas');
const { FRAMEWORKS, RUNTIMES } = require('../../integrations/webpageFramework');
const log = require('../../telemetry/log');

// ── What a page may carry ───────────────────────────────────────────
//
// `framework` and `runtime` are enums, and that is the reason these two stand at the
// top here. It stood there as `FRAMEWORKS.includes(framework) ? framework :
// DEFAULT_NEW_FRAMEWORK`: whoever chose React in the build bar and sent one letter
// wrong ('raect', 'react-MUI') got a page that was built as `vanilla` — with a 200
// that said the page was there. The choice is written once, at creation, and
// afterwards can only be reverted via the settings.
const FRAMEWORK_TEXT = `Kies een framework: ${FRAMEWORKS.join(' of ')}.`;
const RUNTIME_TEXT = `Kies een runtime-niveau: ${RUNTIMES.join(' of ')}.`;

const CreateBody = bodyOf({
    name: worded('Een naam is tekst.').trim().max(200, 'Een naam is hoogstens 200 tekens.').optional(),
    description: worded('Een omschrijving is tekst.').optional(),
    // De brief die de AI elke beurt leest. Zelf meegestuurd wint van de brief
    // die uit `prompt` + de bronnen wordt opgebouwd.
    instructions: worded('Instructies zijn tekst.').optional(),
    prompt: worded('Een opdracht is tekst.').optional(),
    framework: choice(FRAMEWORKS, FRAMEWORK_TEXT).optional(),
    runtime: choice(RUNTIMES, RUNTIME_TEXT).optional(),
    // `{kind, id}`-paren. normalizeCreateSources bouwt ze veld voor veld op en
    // resolveCreateSources toetst élke bron voor DEZE beller vóór de pagina
    // bestaat — dat is waar de allow-list op soorten thuishoort.
    sources: z.array(z.unknown(), { error: typeError({ invalid: 'sources is een lijst.' }) }).optional(),
});

// Wat een save mag veranderen. `.strict()`, want de drie slots reizen mee in
// dezelfde body: `{"nmae": "x", "html": "…"}` sloeg de html op, liet de naam
// staan en antwoordde `{success:true}` — een hernoeming die nooit gebeurde.
const SLOT_TEXT = 'Een bestandsslot is tekst.';
const UpdateBody = bodyOf({
    name: worded('Een naam is tekst.').trim().max(200, 'Een naam is hoogstens 200 tekens.').optional(),
    description: worded('Een omschrijving is tekst.').nullish(),
    instructions: worded('Instructies zijn tekst.').nullish(),
    // A deliberately open configuration block: this is where the framework/runtime choice
    // and what later screens add go. resolveFramework() still reads only the words it
    // knows from it when READING.
    settings: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'settings is een object.' }) }).optional(),
    knowledgeBaseIds: idList('knowledgeBaseIds is een lijst met kennisbank-id\'s.').optional(),
    html: worded(SLOT_TEXT).optional(),
    css: worded(SLOT_TEXT).optional(),
    js: worded(SLOT_TEXT).optional(),
});

function register(router) {
    router.post('/', requireAuth, validate({ body: CreateBody, query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        const { name, description, instructions, framework, runtime } = req.body;
        const prompt = (req.body.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);

        let sources;
        try {
            sources = await resolveCreateSources(req, normalizeCreateSources(req.body.sources));
        } catch (e) {
            if (!e.status) throw e;
            return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
        }

        // Record the framework + runtime tier in settings so the chat handler and
        // preview pipeline know how to build this project. ABSENT falls back to
        // the safe defaults; a word that is not one of the two is refused by the
        // schema and never lands here — see webpageFramework.js.
        const { DEFAULT_NEW_FRAMEWORK, DEFAULT_RUNTIME } = require('../../integrations/webpageFramework');
        const settings = {
            framework: framework ?? DEFAULT_NEW_FRAMEWORK,
            runtime: runtime ?? DEFAULT_RUNTIME,
        };

        const chosenName = (name && name.trim())
            ? name
            : (deriveNameFromPrompt(prompt) || undefined);

        // ONE creation path, shared with the AI's own create_webpage: same name
        // trimming, same "Untitled Webpage" default, same description cap.
        const { executeBuilderTool } = require('../../integrations/webpageBuilderTools');
        const { result } = await executeBuilderTool('create_webpage', { name: chosenName, description }, { userId });
        if (!result || result.error || !result.webpageId) {
            throw new Error(`create_webpage failed: ${result?.error || 'no webpageId'}`);
        }
        const webpageId = result.webpageId;

        // What create_webpage has no concept of. resolveFramework() falls back
        // to 'vanilla' at READ time, so DEFAULT_NEW_FRAMEWORK only ever takes
        // effect because it is written here.
        const brief = (instructions && instructions.trim())
            ? instructions
            : buildBrief(prompt, sources);
        await webpageStore.updateWebpageMetadata(webpageId, userId, {
            settings,
            ...(brief ? { instructions: brief } : {}),
        });

        // A picked automation becomes a real grant — ownership re-checked
        // inside grantAutomation — so the page's card shows it as a linking
        // pill and window.beeflowAutomations can call it. Tables are named in
        // the brief only: bridge_grants grows a `tables` slice in W3, and the
        // normalizer would silently drop one written today.
        for (const s of sources) {
            if (s.kind !== 'automation') continue;
            await require('../../integrations/webpageGrants')
                .grantAutomation({ webpageId, userId, automationId: s.id, label: s.name });
        }

        // A fresh page usually has no table to index yet, but create_webpage CAN fill slots
        // (a template, a brief). The reconcile therefore belongs here too: starting only on
        // the FIRST save would mean that a page that is never edited again would never
        // appear in the index.
        webpageUsageSync.reconcileWebpageUsageDetached(webpageId);

        const webpage = await webpageStore.getWebpage(webpageId, userId);
        res.json({
            success: true,
            webpage: webpage || { id: webpageId, userId, name: result.name, settings },
            // The overview opens the editor on this and seeds the chat with it.
            prompt,
            sources,
        });
    });

    router.get('/', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
        const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
        // resolveUserOrgIds returns null for super-admin (sees everything in scope);
        // collapse to [] so the SQL ANY($orgIds) doesn't blow up — super-admins fall
        // through to their own webpages plus anything they own.
        const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
        const webpages = await webpageStore.getAccessibleWebpages(userId, userGroups, orgIdArr);
        // The overview card paints "who can see this", and a live share link
        // is the widest audience there is (pages/webpages/webpageVisibility).
        // Without this count the card says "Personal" on a page anyone with
        // the link can open. A failed lookup leaves publicShareCount at null
        // — "unknown", which that derivation refuses to paint as private.
        for (const w of webpages) w.publicShareCount = null;
        try {
            const counts = await publicShareStore.countLiveSharesForWebpages(webpages.map(w => w.id));
            for (const w of webpages) w.publicShareCount = counts.get(w.id) ?? null;
        } catch (e) {
            log.warn('[Webpages] public-share count failed:', e.message);
        }
        res.json({ webpages });
    });

    router.get('/:id', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        // Try owner-scoped read first (preserves owner-only RustFS path).
        let webpage = await webpageStore.getWebpage(req.params.id, userId);
        if (!webpage) {
            // Owner mismatch — check published visibility.
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && await webpageStore.canReadWebpageAsync(raw, userId, userGroups, orgIdArr)) {
                webpage = raw;
            }
        }
        if (!webpage) return res.status(404).json({ error: 'Webpage not found' });
        // Files / sources / chat live under the OWNER's RustFS prefix, not the
        // caller's — readSlotsForReader keys off webpage.userId so an
        // org-viewer reads the owner's objects, never their own empty prefix.

        // WHICH bytes: the owner edits the live row, everyone else reads the
        // snapshot the owner pinned by publishing (readSlotsForReader).
        const [sources, read, chatMessages, extraFiles, managed] = await Promise.all([
            webpageStore.getSources(webpage.id),
            readSlotsForReader(webpage, userId),
            // Chat history is per-owner; non-owner viewers get an empty array
            // (don't leak the owner's chat with the AI builder).
            webpage.userId === userId ? webpageStore.getChatMessages(webpage.id, userId) : Promise.resolve([]),
            webpageStore.listExtraFiles(webpage.id),
            // The Solution stage that manages this page, or null (design 5.3).
            webpageStore.managedPayloadOf(webpage),
        ]);
        // timeoutStuckSources is a write (UPDATE ... WHERE status='processing');
        // its own WHERE clause already filters to stale rows, but running it on
        // every page open still costs a DB round-trip even when there's nothing
        // to sweep. Only pay for it when the already-fetched list actually has a
        // processing row, and only re-fetch if it timed one out.
        let finalSources = sources;
        if (sources.some(s => s.status === 'processing')) {
            const timedOut = await webpageStore.timeoutStuckSources(webpage.id).catch(() => 0);
            if (timedOut > 0) finalSources = await webpageStore.getSources(webpage.id);
        }
        // The count the visibility derivation needs (see GET / above); the
        // owner's own editor header is the one place it must never be missing.
        // Written unconditionally, null first: an ABSENT key serialises away
        // entirely, and a client that never sees the field cannot tell "no
        // live links" from "the server could not say".
        webpage.publicShareCount = null;
        try {
            const counts = await publicShareStore.countLiveSharesForWebpages([webpage.id]);
            webpage.publicShareCount = counts.get(webpage.id) ?? null;
        } catch (e) {
            log.warn('[Webpages] public-share count failed:', e.message);
        }
        res.json({
            webpage,
            sources: finalSources,
            files: read.files,
            chatMessages,
            extraFiles,
            readOnly: webpage.userId !== userId,
            // Which snapshot these bytes came from — null for the live row.
            // The client shows what it got; it never has to guess.
            servedVersionId: read.servedVersionId ?? null,
            managed,
        });
    });

    router.put('/:id', requireAuth, validate({ body: UpdateBody, query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        const id = req.params.id;
        const {
            name, description, instructions, settings, knowledgeBaseIds,
            html, css, js,
        } = req.body;

        const wp = await webpageStore.getWebpage(id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Determine which slots actually changed (by sha256). Skip RustFS round-trip
        // for unchanged slots so a metadata-only PUT doesn't re-upload all three files.
        const incoming = { html, css, js };
        const current = { html: wp.htmlSha, css: wp.cssSha, js: wp.jsSha };
        const slotUpdates = {};
        for (const slot of webpageStore.SLOTS) {
            if (incoming[slot] === undefined) continue;
            const newSha = webpageStore.sha256(incoming[slot] || '');
            if (newSha !== current[slot]) {
                slotUpdates[slot] = { content: incoming[slot] || '', sha: newSha };
            }
        }

        // A managed page (a Solution stage) refuses a file change before
        // anything is written, the auto-version below included.
        if (Object.keys(slotUpdates).length > 0) {
            await webpageStore.assertWebpageWrite(id, ['files'], { projectId: wp.projectId || null });
        }

        // Auto-version: if any slot is changing AND debounce elapsed AND there's
        // existing content to snapshot, copy "current/*" → "versions/{vid}/*".
        if (Object.keys(slotUpdates).length > 0) {
            const hasExistingContent = wp.htmlSize + wp.cssSize + wp.jsSize > 0;
            if (hasExistingContent) {
                try {
                    // PER SOURCE. Without this, every AI turn froze the clock of this arm (the AI arm
                    // writes one per turn), and an edit that someone made by hand structurally no
                    // longer got its own restore point.
                    const should = await webpageStore.shouldAutoVersion(id, 'manual');
                    if (should) {
                        // The line difference of the edit that is written away next. The OLD bytes must be
                        // read for that — that costs at most one round per page per debounce window
                        // (5 minutes), because only then do we come here. Read before writeSlot below,
                        // otherwise we would measure the new text against itself.
                        const changed = Object.keys(slotUpdates);
                        let lineDelta = null;
                        try {
                            // FIRST ask whether there is anything to read at all.
                            // `readSlot` answers '' when the storage is gone, and then the whole new text
                            // would be booked as a gain against an old side that was never read.
                            if (!webpageStore.slotsAreReadable()) {
                                throw new Error('object storage unavailable');
                            }
                            const before = {};
                            await Promise.all(changed.map(async (slot) => {
                                before[slot] = await webpageStore.readSlot(userId, id, slot);
                            }));
                            const after = Object.fromEntries(changed.map(s => [s, slotUpdates[s].content]));
                            lineDelta = versionFacts.slotsLineDelta(before, after, changed);
                        } catch (dErr) {
                            log.warn('[Webpages] Auto-version line delta unavailable:', dErr.message);
                        }
                        // "Auto-save" only said THAT something happened. This row belongs to an edit that
                        // someone made by hand in the Code tab; that is what is shown in the list.
                        await webpageStore.createVersion(userId, id, versionFacts.MANUAL_EDIT_SUMMARY, {
                            htmlSha: wp.htmlSha,
                            cssSha: wp.cssSha,
                            jsSha: wp.jsSha,
                            contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
                        }, 'manual', { actorUserId: userId, lineDelta });
                    }
                } catch (vErr) {
                    log.warn('[Webpages] Auto-version failed:', vErr.message);
                }
            }
        }

        // Persist each changed slot to RustFS.
        const metadataUpdate = { name, description, instructions, settings, knowledgeBaseIds };
        for (const [slot, { content }] of Object.entries(slotUpdates)) {
            const { sha, size } = await webpageStore.writeSlot(userId, id, slot, content);
            metadataUpdate[`${slot}Sha`] = sha;
            metadataUpdate[`${slot}Size`] = size;
        }

        // Re-snapshot any active public shares so a published page reflects the
        // edit immediately. The snapshot used to be written only at share
        // creation, so recipients saw the stale version until they cleared their
        // browser cache (BFSF-190). Fire-and-forget — never blocks the save.
        if (Object.keys(slotUpdates).length > 0) {
            reSnapshotWebpageShares(id, userId);
        }

        const ok = await webpageStore.updateWebpageMetadata(id, userId, metadataUpdate);
        if (!ok && Object.keys(slotUpdates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        // Unconditionally, not only on changed slots: the reconcile is debounced and detached,
        // and "only on a slot change" would mean that a page which once fell out of the index
        // would never get back in.
        webpageUsageSync.reconcileWebpageUsageDetached(id);
        res.json({ success: true });
    });
}

module.exports = { register };
