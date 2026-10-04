// @typecheck
/**
 * Attachment text scanner — applies the org Privacy Shield (PII detection)
 * to text extracted from file attachments (PDF / Office / plain text).
 *
 * Reuses the same detector + tokeniser as the message-scan path; never
 * spins up a parallel engine. When per-page text is available (PDFs from
 * pdfjs), findings carry a `page` number for audit attribution.
 *
 * Large-input policy (no unredacted leaks): when the scan can't cover the whole
 * input (page-cap overflow, wall-clock timeout, or a degraded detector result),
 * the UNSCANNED portion is governed by the same failure-mode axis the chat path
 * uses. `piiDetectionAction` (block vs tokenize) governs the SCANNED portion;
 * `attachmentLargeInputPolicy` (falls back to piiFailureMode) governs the
 * UNSCANNED portion:
 *   fail_closed → block/hold the attachment (nothing unscanned proceeds)
 *   fail_open   → redact what was scanned and TRUNCATE at the scan boundary,
 *                 surfaced with an amber warning + audit row.
 *
 * Neither branch forwards unchecked content. fail_open once passed the tail
 * through verbatim, which shipped raw personal data to the model while the UI
 * claimed only placeholders had been sent; the two differ now only in whether
 * the user gets a partial document or a block.
 *
 * Returns one of:
 *   { action: 'pass',     text,            findings,  summary, tokenMap: null }
 *   { action: 'tokenize', text: tokenized, findings,  summary, tokenMap }
 *   { action: 'block',    text: null,      findings,  summary, tokenMap: null, reason }
 *   { action: 'ask',      text,            findings,  summary, tokenMap: null }
 *
 * `ask` only ever comes back when the caller passed `allowAsk: true` (see
 * scanAttachmentText's own doc) — it means "pause and ask the person", never
 * "safe to send as-is". The caller resolves it via attachmentAskFlow.js and
 * finalises with applyAttachmentRedactionChoice(), which returns the same
 * shape as `tokenize` above.
 *
 * The returned `text` is always a drop-in replacement for the extractor's
 * flat `text` so callers can splice it straight into the message content —
 * EXCEPT for `ask`, where `text` is for REVIEW ONLY and must never be spliced
 * into the prompt until the pause resolves.
 */

const crypto = require('crypto');
const {
    detectPii, tokenizeText, ALL_PII_CATEGORY_IDS, LEGACY_CATEGORY_ALIASES,
    // Aliased: `scanBudgetMs`/`windowCountFor` next to this file's own page
    // budgets would read as more of the same, and they are not — they are the
    // chat path's numbers, borrowed here to keep the two in step.
    scanBudgetMs: piiScanBudgetMs, windowCountFor: piiWindowCountFor,
} = require('../privacy/piiDetection');
const { mergeTokenMap, getConversationTokenMap, getConversationPref } = require('./dlpRunner');
const { isCustomTypeId } = require('../privacy/customTypes/ids');
const { withBuiltinDefault } = require('../privacy/customTypes/plan');
const log = require('../../telemetry/log');

// Deployment-level overrides for the three scan budgets below.
//
// These used to be hardcoded, and the per-org fields `attachmentMaxPages` /
// `attachmentScanBudgetMs` that scanAttachmentText() reads are never populated
// by the Privacy Shield (orgShield.js builds a fixed object and drops them), so
// an operator whose guard is slower than ours had NO way to raise the budget:
// a 16-page PDF timed out at 6 pages and the remainder went to the model
// unredacted under the default fail_open policy. Env vars are the honest fix —
// how fast a page scans is a property of the guard's hardware, not of a tenant.
//
// Invalid, empty or non-positive values fall back to the default rather than
// producing a 0ms budget (which would time out every scan instantly).
function _envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        log.warn(`[AttachmentScanner] ignoring ${name}=${JSON.stringify(raw)} — not a positive number; using ${fallback}`);
        return fallback;
    }
    return Math.floor(n);
}

// Cap the number of pages we scan per attachment. Past this, the large-input
// policy decides: fail_closed blocks the attachment, fail_open scans the first
// `maxPages` and passes the remainder with a surfaced warning (never silently).
const MAX_PAGES_DEFAULT = _envInt('DLP_ATTACHMENT_MAX_PAGES', 50);

// Bounded concurrency for per-page detection. The detector is the remote guard
// service, which caps its OWN inference concurrency (GUARD_PII_MAX_CONCURRENCY,
// default 2) — so lanes beyond ~2-3 mostly queue on the guard semaphore. Keep a
// small lane count to overlap HTTP round-trips without pointless queueing.
// Raising this without raising GUARD_PII_MAX_CONCURRENCY to match buys nothing.
const SCAN_CONCURRENCY_DEFAULT = _envInt('DLP_ATTACHMENT_SCAN_CONCURRENCY', 3);

// Scan budget, PER PAGE — not per document.
//
// It used to be a flat 30s for the whole attachment, which is the bug that
// produced the incident this file's header describes: the budget did not scale
// with the work, so a one-page PDF and a fifty-page PDF got the same allowance
// and anything past a handful of pages timed out by construction. The comment
// that used to live here even predicted it ("a 16-page transcript needs ~90s")
// while the default stayed at 30s.
//
// It also made the SAME CONTENT behave differently depending on how it arrived:
// pasted into the chat box it got SCAN_DEADLINE_MS (60s, piiDetection.js), and
// attached as a PDF it got 30s. Users noticed — "if I copy-paste the same
// content from the PDF it works fine" is what reported this.
//
// Now: each page carries its own allowance, so page count no longer decides
// whether pages get scanned at all.
const PER_PAGE_BUDGET_MS = _envInt('DLP_ATTACHMENT_PER_PAGE_BUDGET_MS', 10_000);

// Absolute wall-clock ceiling, so a 300-page document cannot run forever behind
// an interactive request. Reaching it is no longer a leak — see the `incomplete`
// branch, which truncates at the scanned boundary instead of passing the tail.
const MAX_SCAN_MS_DEFAULT = _envInt('DLP_ATTACHMENT_SCAN_BUDGET_MS', 120_000);

// Marker appended when a document is cut at the scanned boundary. It addresses
// the MODEL as well as the reader: a silently truncated document invites a
// confident summary of pages nobody scanned. Same intent as GAP_MARKER in
// core/meetingNotes/summaryHelpers.js.
function _truncationMarker(scannedPages, totalPages) {
    const scope = (scannedPages && totalPages)
        ? `after page ${scannedPages} of ${totalPages}`
        : 'partway through';
    return `\n\n…[document truncated ${scope}. The remaining content could not be checked for personal data and was NOT sent. Do not infer or invent what it contained; say so if the answer depends on it.]`;
}

// In-process LRU. Hits avoid re-scanning identical attachment text under the
// same policy — common when conversations replay history on every turn. Cap
// of 200 keeps the memory footprint trivial (each entry is just findings +
// summary, no buffers retained). Incomplete outcomes (overflow/timeout/
// degraded) are NEVER cached — a later attempt with a lighter load or a higher
// budget/tier may fully scan.
//
// An entry holds the DETECTION only — `{ findings, summary }` — never the
// tokenised text or the token map. The key (text hash + policy tag) is
// process-wide with no conversation in it, so replaying a stored token map
// into a second conversation rebound that conversation's live tokens:
// [email_1] already meaning bob@corp.com became zoe@cache.com from the cached
// attachment, which mis-restores every already-stored turn AND drops
// bob@corp.com out of buildReverseReplacer, so later memory/KB text containing
// it goes to the provider unredacted. Findings are a pure function of the
// cache key; tokenisation is a function of the CONVERSATION, so it is redone
// per call from getConversationTokenMap — exactly as on the fresh path.
const SCAN_CACHE_MAX = 200;
const _scanCache = new Map();

function _policyTag(orgShield) {
    const cats = Array.isArray(orgShield?.piiDetectionCategories) ? orgShield.piiDetectionCategories.slice().sort().join(',') : '';
    const t = orgShield?.piiDetectionConfidenceThreshold ?? '';
    const a = orgShield?.piiDetectionAction || orgShield?.privacyAction || '';
    const p = _resolveLargeInputPolicy(orgShield);
    // A custom type keeps its id when its words change; the digest does not.
    const c = orgShield?.customTypesDigest ? `|c=${orgShield.customTypesDigest}` : '';
    return `${a}|${t}|${cats}|${p}${c}`;
}

function _cacheKey(text, orgShield) {
    const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
    return `${hash}|${_policyTag(orgShield)}`;
}

function _cacheGet(key) {
    const v = _scanCache.get(key);
    if (!v) return null;
    // Move-to-end LRU.
    _scanCache.delete(key);
    _scanCache.set(key, v);
    return v;
}

function _cacheSet(key, value) {
    if (_scanCache.size >= SCAN_CACHE_MAX) {
        const oldest = _scanCache.keys().next().value;
        _scanCache.delete(oldest);
    }
    _scanCache.set(key, value);
}

function _resolveAction(orgShield, allowAsk = false) {
    // `dlpMode: 'ask'` has no legacy equivalent — `piiDetectionAction` only
    // ever stores 'block'/'tokenize', and resolveOrgShield ALWAYS populates
    // it (falls back to the global config, then 'block') — so without this
    // explicit carve-out an org running the interactive DLP "ask" experience
    // would silently fall through to the legacy branch below and attachments
    // would never pause, no matter what dlpMode says. This is the ONLY place
    // dlpMode is read in this file; every other action still resolves off
    // piiDetectionAction/privacyAction exactly as before.
    //
    // Gated behind `allowAsk` — an explicit per-CALLER opt-in, not an org
    // setting. `scanAttachmentText` has six call sites (agent chat, direct
    // chat, webpage/template/notebook chat, notebook source ingestion); only
    // the two live interactive chat surfaces know how to pause a turn and
    // resume it on a decision. The other four just check `action === 'block'`
    // and otherwise use `result.text` — an unhandled 'ask' would hand them
    // the ORIGINAL UNREDACTED text as if it were safe (`ask` intentionally
    // returns `text` unchanged; redaction happens only after the decision).
    // Callers that never pass `allowAsk: true` see IDENTICAL behaviour to
    // before this action existed, regardless of the org's dlpMode.
    if (allowAsk && orgShield?.dlpEnabled && orgShield?.dlpMode === 'ask') return 'ask';
    // Privacy Shield UI writes `piiDetectionAction` ∈ {'block','tokenize'}.
    // The canonical synthesised field is `privacyAction` ∈ {'block','redact','ask'}.
    const legacy = orgShield?.piiDetectionAction;
    if (legacy === 'block') return 'block';
    if (legacy === 'tokenize' || legacy === 'redact') return 'tokenize';
    const canonical = orgShield?.privacyAction;
    if (canonical === 'block') return 'block';
    if (canonical === 'redact') return 'tokenize';
    return 'tokenize';
}

// Failure mode for when detection can't fully run — same precedence the chat
// path and dlpRunner use (piiFailureMode → dlpFailureMode → fail_closed).
function _resolveFailureMode(orgShield) {
    return orgShield?.piiFailureMode || orgShield?.dlpFailureMode || 'fail_closed';
}

// Large-input policy for the UNSCANNED portion (overflow/timeout/degraded).
//
// This used to hardcode 'fail_open' — deliberately NOT derived from
// piiFailureMode — to avoid "a surprise hard-block regression" for orgs that
// upload big PDFs. That reasoning rested on timeouts being a normal event,
// which they were only because the budget did not scale with page count (see
// PER_PAGE_BUDGET_MS). With a per-page budget an incomplete scan is an
// exception, not the daily case, so the setting can finally mean what the
// header of this file has always claimed it meant.
//
// An explicit org value still wins; absent one we follow the same failure-mode
// axis as chat and automations (piiFailureMode → dlpFailureMode → fail_closed).
// Note that fail_open no longer passes the unscanned tail either — it truncates
// at the scanned boundary. Neither branch can leak now; they differ in whether
// the user gets a partial document or a block.
function _resolveLargeInputPolicy(orgShield) {
    const explicit = orgShield?.attachmentLargeInputPolicy;
    if (explicit === 'fail_open' || explicit === 'fail_closed') return explicit;
    return _resolveFailureMode(orgShield);
}

// Legacy ids FIRST, then the whitelist — the order is the whole point.
//
// A shield saved before a category rename still stores e.g.
// `EUNationalIdentificationNumber`. validateInputForPii aliases it to the
// canonical id (piiDetection.js:LEGACY_CATEGORY_ALIASES), which is why typing a
// BSN into chat is still redacted. Filtering first DROPS the legacy id instead,
// so the very same BSN inside an uploaded PDF was scanned for every category the
// org selected EXCEPT that one, and the document reached the model with the
// national ID in the clear. One stored field must not mean two different things
// depending on which door the text came through.
function _resolveCategories(orgShield) {
    const cats = orgShield?.piiDetectionCategories;
    if (Array.isArray(cats) && cats.length > 0) {
        // "Your own data" ids are kept, not filtered away as unknown: dropping
        // them would scan an uploaded file for everything EXCEPT the org's own
        // data, the same one-field-two-meanings bug as the legacy ids above.
        return withBuiltinDefault(cats
            .map(id => LEGACY_CATEGORY_ALIASES[id] || id)
            .filter(id => ALL_PII_CATEGORY_IDS.includes(id) || isCustomTypeId(id)));
    }
    return null; // null = detect everything the backend supports
}

function _resolveThreshold(orgShield) {
    const t = orgShield?.piiDetectionConfidenceThreshold;
    return typeof t === 'number' ? t : undefined;
}

function _piiEnabled(orgShield) {
    if (!orgShield) return false;
    // Shield's master flag is the only switch for PII scanning.
    return !!orgShield.enabled;
}

// The page-offset walk lives in core/documents/pageOffsets.js.
//
// It was worked out twice here — once to re-base entity offsets, once to find
// the boundary of the scanned prefix — with a comment on the second saying it
// had to stay in step with the first. K6's chunker needs the same walk a third
// time, to stamp a page on each chunk, and three copies of a rule whose
// failure mode is "off by two characters, silently" is two too many.
const { entitiesToFlatOffsets: _entitiesToFlatOffsets, flatBoundaryForPages: _flatBoundaryForPages } = require('../documents/pageOffsets');

/**
 * `count` is DISTINCT VALUES, `mentions` is occurrences.
 *
 * These were one number before, and the two halves of the product disagreed
 * about which: the attachment path reported spans while every text path
 * (dlpPreflight, directChat message-PII, guardrailsRunner) reported
 * Object.keys(tokenMap).length. Both landed in the same `tokenCount` field and
 * were then SUMMED client-side, so a turn with a PDF plus typed PII produced
 * `spans + unique_values` — a number that means nothing.
 *
 * Distinct wins because it is the only one the user can verify: it equals the
 * number of rows in the TOKEN MAPPING table. `count` here is provisional
 * (deduped on the raw value); the caller overwrites it with the exact token
 * count once tokenizeText has folded aliases together.
 */
function _summariseFindings(findings) {
    const distinct = new Set();
    const total = { byCategory: {}, count: 0, mentions: findings.length, pages: {} };
    for (const f of findings) {
        const key = f.label || f.category || 'Other';
        total.byCategory[key] = (total.byCategory[key] || 0) + 1;
        distinct.add(`${key}|${String(f.text || '').trim().toLowerCase()}`);
        if (f.page) {
            if (!total.pages[f.page]) total.pages[f.page] = {};
            total.pages[f.page][key] = (total.pages[f.page][key] || 0) + 1;
        }
    }
    total.count = distinct.size;
    return total;
}

/**
 * Turn a COMPLETE scan (fresh or cached) into the caller's result.
 *
 * Everything conversation-specific lives here and nowhere else, so the cache
 * can hold the detection alone. Tokenisation seeds from the conversation's
 * accumulated map so attachment tokens continue the per-category counter and
 * known values reuse their existing token (avoids two different bank-account
 * numbers both getting [bankaccount_1], and — the reason this is called on the
 * cache-hit path too — avoids re-binding a token this conversation already
 * minted for someone else's value).
 *
 * `summary` is copied, never mutated: on a hit it is the cached entry's own
 * object and `count` differs per conversation.
 */
function _finaliseCompleteScan({ text, findings, summary, action, conversationId, filename, cacheHit = false }) {
    const out = { ...summary, filename };
    if (cacheHit) out.cacheHit = true;

    if (findings.length === 0) {
        return { action: 'pass', text, findings: [], summary: out, tokenMap: null };
    }
    if (action === 'block') {
        // Categories by label, except an org's own type, which is logged by id.
        const logCats = [...new Set(findings.map(f => (isCustomTypeId(f.category) ? f.category : (f.label || f.category || 'Other'))))];
        log.warn(`[AttachmentScanner] 🚫 ${filename}: ${findings.length} finding(s) — blocking (categories: ${logCats.join(', ')})`);
        return { action: 'block', reason: 'pii', text: null, findings, summary: out, tokenMap: null };
    }
    if (action === 'ask') {
        // Caller pauses (batches this into one review alongside any other
        // pending attachments) and later calls applyAttachmentRedactionChoice
        // with the user's decision — never tokenised here.
        return { action: 'ask', text, findings, summary: out, tokenMap: null };
    }
    if (action === 'pass_through') {
        // Remembered "allow" from an earlier ask this conversation — still
        // report what was found (audit trail, TokenisedBadge), just don't
        // redact it.
        log.warn(`[AttachmentScanner] ${filename}: remembered "allow" — passing ${findings.length} finding(s) through unredacted`);
        return { action: 'pass', text, findings, summary: out, tokenMap: null };
    }

    // Tokenise. Use the flat text since findings carry flat offsets.
    const existing = conversationId ? getConversationTokenMap(conversationId) : null;
    const { tokenizedText, tokenMap } = tokenizeText(text, findings, existing);
    if (conversationId) {
        mergeTokenMap(conversationId, tokenMap);
    }
    // Exact distinct count, now that aliases have been folded together
    // ("Tom"/"Tom Smit" share one token). This is the number the TOKEN MAPPING
    // table has rows for, which is what makes the badge checkable.
    out.count = Object.keys(tokenMap).length;
    log.info(`[AttachmentScanner] 🔒 ${filename}: tokenised ${out.count} value(s) across ${out.mentions} mention(s)${cacheHit ? ' (cached scan)' : ` in ${out.scanMs}ms`}`);
    return { action: 'tokenize', text: tokenizedText, findings, summary: out, tokenMap };
}

/**
 * Apply the user's "redact" decision from an attachment ask-pause. Merges
 * server-side-validated manual additions (the caller already re-sliced them
 * from the SAME `text` this was scanned against — see attachmentIntake.js /
 * attachmentProcessor.js) into `findings` before tokenising, so a manual
 * mark and an auto finding go through the identical splice-and-token-mint
 * path `_finaliseCompleteScan`'s tokenize branch uses (resolveSpanOverlaps
 * inside tokenizeText dedupes any overlap between the two for free).
 *
 * @param {{ text: string, findings: Array, conversationId?: string, filename?: string }} params
 * @returns {Promise<{ action: 'tokenize', text: string, findings: Array, summary: object, tokenMap: object|null }>}
 */
async function applyAttachmentRedactionChoice({ text, findings, conversationId, filename }) {
    const existing = conversationId ? getConversationTokenMap(conversationId) : null;
    const { tokenizedText, tokenMap } = tokenizeText(text, findings, existing);
    if (conversationId) mergeTokenMap(conversationId, tokenMap);
    const summary = _summariseFindings(findings);
    summary.filename = filename;
    summary.count = Object.keys(tokenMap).length;
    log.info(`[AttachmentScanner] 🔒 ${filename}: tokenised ${summary.count} value(s) across ${summary.mentions} mention(s) (user-reviewed)`);
    return { action: 'tokenize', text: tokenizedText, findings, summary, tokenMap };
}

/**
 * @param {object} params
 * @param {string} params.text                Concatenated extracted text.
 * @param {Array<{pageNumber:number,text:string}>} [params.pages]  Per-page text (PDF). Optional.
 * @param {string} params.filename
 * @param {object} params.orgShield           Resolved Privacy Shield config.
 * @param {string} [params.conversationId]    Used to merge attachment tokens into the conv map.
 * @param {number} [params.maxPages]
 * @param {number} [params.concurrency]       pages scanned in parallel
 * @param {number} [params.maxScanMs]         Absolute wall-clock ceiling for the whole scan.
 * @param {number} [params.perPageBudgetMs]   Allowance per page; the effective budget is
 *                                            min(pages x this, maxScanMs).
 * @param {boolean} [params.allowAsk]         Opt-in: this caller can pause on `action:'ask'`
 *                                            and later call applyAttachmentRedactionChoice.
 *                                            Default false — every non-interactive caller
 *                                            (webpage/template/notebook chat, notebook
 *                                            ingestion) is unaffected by dlpMode:'ask'.
 */
async function scanAttachmentText({ text, pages, filename, orgShield, conversationId, maxPages = MAX_PAGES_DEFAULT, concurrency = SCAN_CONCURRENCY_DEFAULT, maxScanMs = MAX_SCAN_MS_DEFAULT, perPageBudgetMs = PER_PAGE_BUDGET_MS, allowAsk = false }) {
    if (!text || text.length < 3) {
        return { action: 'pass', text: text || '', findings: [], summary: { count: 0, byCategory: {}, pages: {} }, tokenMap: null };
    }
    if (!_piiEnabled(orgShield)) {
        return { action: 'pass', text, findings: [], summary: { count: 0, byCategory: {}, pages: {} }, tokenMap: null };
    }

    let action = _resolveAction(orgShield, allowAsk);       // scanned-portion action
    // A "remember my choice" from an earlier ask THIS conversation (text or
    // attachment — dlpRunner's pref is conversation-scoped, not per-surface)
    // governs here too, so a remembered 'allow'/'redact' doesn't re-litigate
    // on every subsequent attachment.
    if (action === 'ask' && conversationId) {
        const remembered = getConversationPref(conversationId);
        if (remembered === 'allow') action = 'pass_through';
        else if (remembered === 'redact') action = 'tokenize';
    }

    // Cache short-circuit. Re-uploads / history replays hit this path with
    // identical extracted text + same policy → reuse the prior DETECTION and
    // re-tokenise it against THIS conversation's map (never replay the stored
    // one — see the cache comment above).
    const cacheKey = _cacheKey(text, orgShield);
    const cached = _cacheGet(cacheKey);
    if (cached) {
        log.info(`[AttachmentScanner] cache hit for ${filename} (${cached.findings.length} finding(s))`);
        return _finaliseCompleteScan({
            text,
            findings: cached.findings,
            summary: cached.summary,
            action, conversationId, filename, cacheHit: true,
        });
    }

    const largeInputPolicy = _resolveLargeInputPolicy(orgShield);   // unscanned-portion policy
    const categories = _resolveCategories(orgShield);
    const threshold = _resolveThreshold(orgShield);
    const effMaxPages = Number.isFinite(orgShield?.attachmentMaxPages) ? orgShield.attachmentMaxPages : maxPages;
    const ceilingMs = Number.isFinite(orgShield?.attachmentScanBudgetMs) ? orgShield.attachmentScanBudgetMs : maxScanMs;

    const usePerPage = Array.isArray(pages) && pages.length > 0;

    // Budget scales with the work. A caller-supplied maxScanMs (tests, notebook
    // ingestion) is still honoured as the ceiling; within it every page carries
    // its own allowance, so page count no longer decides whether pages get
    // scanned. The non-paginated branch hands the whole text to detectPii, which
    // windows and deadlines it internally (piiDetection.js SCAN_DEADLINE_MS) —
    // giving it the ceiling here is what stops an attachment from being held to
    // a stricter budget than the same text pasted into the chat box.
    const pageBudgetMs = usePerPage
        ? Math.min(Math.min(pages.length, effMaxPages) * perPageBudgetMs, ceilingMs)
        // Whole-text: detectPii windows this itself and allows it
        // min(windows x per-window allowance, its own ceiling). Racing it
        // against a SMALLER number would hold a pasted-in .txt to a stricter
        // budget than the identical characters typed into the chat box — the
        // arrival-route asymmetry this file's header is about. So take
        // whichever ceiling is higher.
        : Math.max(ceilingMs, piiScanBudgetMs(piiWindowCountFor(text)));

    const start = Date.now();
    const deadline = start + pageBudgetMs;
    const totalPages = usePerPage ? pages.length : null;
    let overflow = false;
    let timedOut = false;
    let anyDegraded = false;
    let degradedReason = null;
    let scannedPages = 0;
    const pageEntities = [];

    // OVERFLOW under fail_closed: the doc has more pages than we'll scan and we
    // can't clear the remainder — block BEFORE spending any scan budget.
    if (usePerPage && pages.length > effMaxPages && largeInputPolicy === 'fail_closed') {
        const summary = {
            count: 0, byCategory: {}, pages: {}, overflow: true, timeout: false,
            degraded: false, scannedPages: 0, totalPages, held: true,
            reason: 'overflow', filename, scanMs: 0,
        };
        log.warn(`[AttachmentScanner] 🚫 ${filename}: ${pages.length} pages > cap ${effMaxPages} — failing closed (block)`);
        return { action: 'block', reason: 'overflow', text: null, findings: [], summary, tokenMap: null };
    }

    if (usePerPage) {
        const scanPages = pages.slice(0, effMaxPages);
        if (pages.length > effMaxPages) {
            overflow = true;
            log.warn(`[AttachmentScanner] ${filename}: ${pages.length} pages exceeds cap (${effMaxPages}); only first ${effMaxPages} scanned`);
        }
        for (let i = 0; i < scanPages.length; i++) pageEntities[i] = [];

        // Bounded-concurrency runner. `next` is a shared cursor; each worker
        // picks the next index, runs the scan, writes the result, repeats.
        // `cancelled` is set when block-mode short-circuits OR the deadline
        // trips, causing workers to exit cleanly.
        let next = 0;
        let cancelled = false;
        const worker = async () => {
            while (true) {
                if (cancelled) return;
                if (Date.now() >= deadline) { cancelled = true; timedOut = true; return; }
                const i = next++;
                if (i >= scanPages.length) return;
                const p = scanPages[i];
                const pageText = (p.text || '').trim();
                if (!pageText) { scannedPages++; continue; }
                try {
                    const result = await detectPii(pageText, categories, threshold, { priority: 'bulk' });
                    pageEntities[i] = result?.hasPii ? result.entities : [];
                    if (result?.degraded) { anyDegraded = true; degradedReason = degradedReason || result.degradedReason || 'degraded'; }
                } catch (err) {
                    log.warn(`[AttachmentScanner] ${filename} p.${p.pageNumber} scan failed: ${err.message}`);
                    pageEntities[i] = [];
                    anyDegraded = true;
                    degradedReason = degradedReason || `scan_error: ${err.message}`;
                }
                scannedPages++;
                // Short-circuit on block-mode so we don't burn cycles on a 50-page
                // PDF when we already know the message is going to be rejected.
                if (action === 'block' && pageEntities[i].length > 0) { cancelled = true; return; }
            }
        };
        const lanes = Math.max(1, Math.min(concurrency, scanPages.length));
        await Promise.all(Array.from({ length: lanes }, () => worker()));
        if (timedOut) {
            log.warn(`[AttachmentScanner] ${filename}: deadline hit at ${pageBudgetMs}ms (${perPageBudgetMs}ms/page, ceiling ${ceilingMs}ms); ${scannedPages} of ${scanPages.length} pages scanned`);
        }
    } else {
        try {
            // Race the detect call against the deadline so the whole-text
            // path can't outrun the budget either.
            // The loser of this race must be cleared. setTimeout keeps a ref'd
            // handle alive until it fires, so on the NORMAL path — detectPii
            // wins — an uncleared timer sat armed for the rest of the budget
            // (DLP_ATTACHMENT_SCAN_BUDGET_MS, 120s by default) holding its
            // closure: one leaked timer per attachment scanned. It also kept
            // the event loop from draining, which is how the test file found
            // it (23/23 passing, then killed on the runner timeout).
            let deadlineTimer = null;
            const result = await Promise.race([
                detectPii(text, categories, threshold, { priority: 'bulk' }),
                new Promise((resolve) => {
                    deadlineTimer = setTimeout(() => { timedOut = true; resolve(null); }, Math.max(0, deadline - Date.now()));
                }),
            ]).finally(() => { if (deadlineTimer) clearTimeout(deadlineTimer); });
            if (result?.degraded) { anyDegraded = true; degradedReason = result.degradedReason || 'degraded'; }
            const entities = result?.hasPii ? result.entities : [];
            // Whole-text path: page = null (caller stores NULL in audit).
            pageEntities.push(entities.map(e => ({ ...e, page: null })));
            scannedPages = timedOut ? 0 : 1;
        } catch (err) {
            log.warn(`[AttachmentScanner] ${filename} whole-text scan failed: ${err.message}`);
            pageEntities.push([]);
            anyDegraded = true;
            degradedReason = `scan_error: ${err.message}`;
        }
    }

    // Flatten findings with offsets resolved to the concatenated text we'll
    // tokenise against. For the no-pages branch the offsets are already
    // relative to `text`, so we just copy them through. IMPORTANT: on timeout
    // we KEEP the partial findings collected so far (fixes the old leak where
    // they were discarded).
    let findings;
    if (usePerPage) {
        findings = _entitiesToFlatOffsets(pageEntities, pages.slice(0, effMaxPages));
    } else {
        findings = pageEntities[0] || [];
    }

    const incomplete = overflow || timedOut || anyDegraded;
    const reason = timedOut ? 'timeout' : (overflow ? 'overflow' : (anyDegraded ? 'degraded' : null));

    const summary = _summariseFindings(findings);
    summary.overflow = overflow;
    summary.timeout = timedOut;
    summary.degraded = anyDegraded;
    summary.degradedReason = degradedReason;
    summary.scannedPages = scannedPages;
    summary.totalPages = totalPages;
    summary.reason = reason;
    summary.held = false;
    summary.filename = filename;
    summary.scanMs = Date.now() - start;

    // ── Incomplete scan (overflow / timeout / degraded) ──────────────────
    // Governed by the large-input policy, NOT silently passed. Never cached.
    if (incomplete) {
        if (largeInputPolicy === 'fail_closed') {
            summary.held = true;
            log.warn(`[AttachmentScanner] 🚫 ${filename}: scan ${reason} — failing closed (block/hold)`);
            return { action: 'block', reason, text: null, findings, summary, tokenMap: null };
        }
        // fail_open — proceed, but ONLY with what we actually checked.
        //
        // This branch used to hand back the full `text`. Because tokenizeText is
        // a splice-by-offset over spans found in the scanned prefix, the result
        // was [scanned pages, tokenised] + [unscanned pages, verbatim] — so an
        // unfinished scan shipped raw personal data to the model while the UI
        // told the user only placeholders had been sent. That was the incident.
        //
        // Now the tail is CUT at the scan boundary. fail_open still means "the
        // user gets an answer rather than a block", but it can no longer mean
        // "content nobody checked leaves the platform".
        const boundary = usePerPage
            ? _flatBoundaryForPages(pages, scannedPages)
            : (scannedPages > 0 ? text.length : 0);
        const truncated = boundary < text.length;
        const keptText = truncated
            ? text.slice(0, boundary) + _truncationMarker(scannedPages, totalPages)
            : text;
        summary.truncated = truncated;
        summary.sentChars = boundary;
        summary.totalChars = text.length;

        // ask / pass_through short-circuit before the existing block/tokenize
        // logic below. Bounds-critical: `keptText` (not the full `text`) is
        // what gets reviewed AND what any manual addition is later re-sliced
        // against — a user must never be able to "mark" content past the
        // scan boundary that was genuinely never checked. Zero findings in
        // the scanned prefix falls through unchanged (no forced pause on an
        // incomplete-but-clean scan; the "Scan incomplete" badge already
        // makes the truncation visible).
        if (findings.length > 0 && action === 'ask') {
            return { action: 'ask', text: keptText, findings, summary, tokenMap: null };
        }
        if (action === 'pass_through') {
            log.warn(`[AttachmentScanner] ${filename}: remembered "allow" — passing ${findings.length} finding(s) through unredacted (partial scan, ${reason})`);
            return { action: 'pass', text: keptText, findings, summary, tokenMap: null };
        }

        if (action === 'block') {
            if (findings.length > 0) {
                log.warn(`[AttachmentScanner] 🚫 ${filename}: ${findings.length} finding(s) in scanned pages (${reason}) — blocking`);
                return { action: 'block', reason: 'pii', text: null, findings, summary, tokenMap: null };
            }
            // Nothing found in the part we checked. fail_open says proceed —
            // with the checked part only.
            log.warn(`[AttachmentScanner] ⚠️ ${filename}: scan ${reason}, no findings in scanned part — truncating at ${boundary}/${text.length} chars`);
            return { action: 'pass', text: keptText, findings: [], summary, tokenMap: null };
        }
        if (findings.length > 0) {
            const existing = conversationId ? getConversationTokenMap(conversationId) : null;
            // Offsets are relative to the flat text and all findings come from
            // the scanned prefix, so they stay valid against the truncated copy.
            const { tokenizedText, tokenMap } = tokenizeText(keptText, findings, existing);
            if (conversationId) mergeTokenMap(conversationId, tokenMap);
            summary.count = Object.keys(tokenMap).length;
            log.warn(`[AttachmentScanner] ⚠️ 🔒 ${filename}: partial scan (${reason}) — tokenised ${summary.count} value(s) across ${summary.mentions} mention(s); tail cut at ${boundary}/${text.length} chars`);
            return { action: 'tokenize', text: tokenizedText, findings, summary, tokenMap };
        }
        log.warn(`[AttachmentScanner] ⚠️ ${filename}: scan ${reason}, no findings — truncating at ${boundary}/${text.length} chars`);
        return { action: 'pass', text: keptText, findings: [], summary, tokenMap: null };
    }

    // ── Complete scan ────────────────────────────────────────────────────
    // Cache the DETECTION (a pure function of the key), then finalise through
    // the same helper the cache-hit path uses, so a hit and a miss differ only
    // in whether the guard was called.
    _cacheSet(cacheKey, { findings, summary });
    return _finaliseCompleteScan({ text, findings, summary, action, conversationId, filename });
}

class AttachmentPrivacyBlock extends Error {
    constructor({ filename, summary, findings, reason }) {
        const cause = reason && reason !== 'pii' ? reason : null;
        const cats = Object.keys(summary?.byCategory || {}).join(', ') || 'unknown';
        const msg = cause === 'overflow'
            ? `Attachment "${filename}" is too large to fully scan for sensitive data. Split it or reduce the page count, then re-upload.`
            : cause === 'timeout'
                ? `Scanning "${filename}" for sensitive data didn't finish in time. Please try again or split the document.`
                : cause === 'degraded'
                    ? `Sensitive-data scanning for "${filename}" is temporarily unavailable. Please try again shortly.`
                    : `PII detected in attachment "${filename}" (${cats}). Please remove sensitive data and re-upload.`;
        super(msg);
        this.code = 'ATTACHMENT_PII_BLOCKED';
        this.reason = reason || 'pii';
        this.filename = filename;
        this.summary = summary;
        this.findings = findings;
    }
}

module.exports = {
    scanAttachmentText,
    applyAttachmentRedactionChoice,
    AttachmentPrivacyBlock,
    MAX_PAGES_DEFAULT,
    _resolveLargeInputPolicy,   // exported for tests
    _resolveFailureMode,
    _resolveAction,             // exported for tests
};
