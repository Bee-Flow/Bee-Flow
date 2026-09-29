// @typecheck
/**
 * Privacy Shield at knowledge-base ingest.
 *
 * A THIN ADAPTER over machinery that already exists — `resolveShieldFor` and
 * `attachmentScanner.scanAttachmentText` — not a second scanner. The detection,
 * the page budgets, the category aliasing and the tokenisation are all the
 * attachment path's, so a BSN in an uploaded PDF is treated the same whether it
 * arrives through chat or through a knowledge base. What this file owns is the
 * translation from that machinery's vocabulary into a `documents` row.
 *
 * ── THE TOKEN MAP IS THROWN AWAY, AND THAT IS THE FEATURE ───────────
 * In chat, tokenisation is reversible: `[email_1]` goes to the model and the
 * real address is spliced back into the reply. A knowledge base is not a
 * conversation — the tokenised text is CHUNKED, EMBEDDED AND STORED, and it
 * will be quoted to people who were never party to the document. So no
 * `conversationId` is passed, no map is merged, and the map that comes back is
 * dropped on the floor. What lands in `original_content` is what the agent will
 * ever know:
 *
 *     the agent knows the terms, not the customer.
 *
 * That is also why this cannot be undone by re-indexing: `original_content` IS
 * the redacted text. There is no copy of the original anywhere to restore from,
 * which is the point rather than a limitation.
 *
 * ── "ASK" IS NOT A THING A BACKGROUND JOB CAN DO ────────────────────
 * The org's action may be `ask` — pause and let the person decide. There is
 * nobody to ask at 06:00 when a scheduled refresh pulls a new file out of a
 * folder, so this path never opts into it (`allowAsk` stays false) and the
 * scanner resolves `ask` to `tokenize` on its own. Redacting is the safe
 * reading of "I want to be asked": it is what a person choosing carefully
 * would pick, and unlike `pass` it cannot be wrong in the direction that
 * matters.
 *
 * ── AND NEITHER IS FAILING SILENTLY ─────────────────────────────────
 * Four different things can go wrong, and they must not collapse into one
 * status, because "we checked and it was clean" and "we could not check" are
 * different promises:
 *
 *   guard not installed   → `unscanned`, document kept. The feature is off;
 *                           pretending it ran and found nothing would be a
 *                           claim nobody made.
 *   guard degraded,
 *     fail_closed         → `skipped`, retried on the next refresh. The org
 *                           asked not to store what could not be checked.
 *   guard degraded,
 *     fail_open           → `unscanned`, document kept, amber in the UI.
 *   personal data found,
 *     action `block`      → `skipped`, reason names the categories.
 *
 * `pii_status` therefore has four values, not two: none | found | redacted |
 * unscanned. A UI that only knew "clean or redacted" would show the third and
 * fourth as clean.
 */

const { isCustomTypeId } = require('../privacy/customTypes/ids');
const { displayNameFor } = require('../privacy/customTypes/registry');
const { resolveShieldFor } = require('../privacy/orgShield');
const { scanAttachmentText } = require('../dlp/attachmentScanner');

/** The org setting that turns this path on. Default: follow the shield. */
const CONFIG_KEY = 'privacy_scan_knowledge_bases';

/**
 * Statuses this module can hand back, so a caller can switch exhaustively.
 * `skipped` means the row is kept with a reason and NO content — never that
 * the document silently vanished, which is the behaviour K1 removed.
 */
const OUTCOME = Object.freeze({
    PASS: 'pass',       // store `text` as given
    REDACTED: 'redacted', // store `text` (tokenised), pii_status redacted
    SKIPPED: 'skipped',  // do not store content; keep the row + reason
});

/**
 * Is the guard actually installed?
 *
 * `detectPii` returns null in that case, and the scanner cannot tell that
 * apart from "scanned, found nothing" — both surface as `action:'pass'` with
 * zero findings. Asking the endpoint directly is the only way to distinguish
 * "clean" from "never looked", and the answer is cached by `guardEndpoint`,
 * so this is not a per-document round trip.
 */
async function guardInstalled() {
    try {
        const { getGuardEndpoint } = require('../privacy/piiDetection/guardEndpoint');
        const ep = await getGuardEndpoint();
        return !!ep?.url;
    } catch (_) {
        return false;
    }
}

/**
 * Should knowledge-base ingest be scanned for this org at all?
 *
 * Defaults to ON when the shield is on: a person who switched Privacy Shield
 * on for their organisation did not mean "except the documents you keep
 * forever and quote to customers". The setting exists so an org that finds the
 * recall cost too high can turn it off deliberately, not so it starts off.
 */
function scanEnabledFor(shield) {
    if (!shield?.enabled) return false;
    const v = shield[CONFIG_KEY];
    return v === undefined || v === null ? true : !!v;
}

/**
 * The one legacy value that means "mark it, do not touch it".
 *
 * `resolveUserShield` clamps `piiDetectionAction` to block|tokenize, but
 * `resolveOrgShield` passes the stored value through unvalidated, so an org
 * row written before that clamp existed can still hold `warn`. The scanner's
 * `_resolveAction` does not know the value and falls through to `tokenize`,
 * which would silently upgrade a "just tell me" setting into redaction. Read
 * it here, before the scan, and honour it: mark the document `found` and
 * store the REAL text.
 */
function isLegacyWarn(shield) {
    return shield?.piiDetectionAction === 'warn';
}

/**
 * Screen one document's text before it is hashed, chunked and stored.
 *
 * Runs BEFORE the content hash (kbIngestionHelpers step 2) so dedup is stable:
 * the same file uploaded twice tokenises identically and dedups, whereas
 * hashing first and redacting second would give two rows with the same hash
 * and different content.
 *
 * @param {object} p
 * @param {string|null} p.orgId
 * @param {string|null} p.userId
 * @param {string}      p.text
 * @param {string}      [p.filename]  for the scanner's logs only
 * @param {Array}       [p.pages]     `[{pageNumber,text}]` when the extractor
 *                                    produced them — enables per-page budgets
 *                                    and a truncation boundary on a page edge
 * @param {object}      [p.deps]      injection seam for the tests
 * @returns {Promise<{outcome, text, piiStatus, piiCategories, reason}>}
 *          Never throws. A privacy check that crashes must not take the
 *          ingest with it — it returns `unscanned`, which is visible.
 */
async function applyShield({ orgId, userId, text, filename = 'document', pages = null, deps = {} } = /** @type {any} */ ({})) {
    const clean = (t, status, extra = {}) => ({
        outcome: OUTCOME.PASS, text: t, piiStatus: status, piiCategories: null, reason: null, ...extra,
    });

    if (!text || !String(text).trim()) return clean(text, 'none');

    const resolve = deps.resolveShieldFor || resolveShieldFor;
    const scan = deps.scanAttachmentText || scanAttachmentText;
    const installed = deps.guardInstalled || guardInstalled;

    let shield = null;
    try {
        shield = await resolve({ orgId, userId });
    } catch (e) {
        // Cannot read the policy → cannot claim to have applied it.
        return clean(text, 'unscanned', { reason: `Privacy settings unavailable: ${e.message}` });
    }

    // Shield off, or knowledge bases excluded from it: not "unscanned", which
    // would put an amber chip on every document of an org that never asked for
    // scanning. Nothing was promised, so nothing is flagged.
    if (!scanEnabledFor(shield)) return clean(text, 'none');

    if (!(await installed())) {
        return clean(text, 'unscanned', { reason: 'Personal-data detection is not installed' });
    }

    let result;
    try {
        result = await scan({
            text,
            pages: Array.isArray(pages) && pages.length ? pages : null,
            filename,
            orgShield: shield,
            // No conversation: the token map must not be merged into one, and
            // must not be replayed from one. See the header.
            conversationId: null,
            // Never. There is nobody to ask in a background ingest.
            allowAsk: false,
        });
    } catch (e) {
        // The scanner failing is not the same as the document being clean.
        return clean(text, 'unscanned', { reason: `Privacy scan failed: ${e.message}` });
    }

    const categories = categoriesOf(result);

    // Legacy "warn": mark, do not modify. Checked AFTER the scan because the
    // findings are what the mark is made of, and before the action switch
    // because the scanner has already resolved `warn` to `tokenize`.
    if (isLegacyWarn(shield) && result.action === 'tokenize') {
        return {
            outcome: OUTCOME.PASS,
            text,                       // the ORIGINAL, deliberately
            piiStatus: (result.findings || []).length > 0 ? 'found' : 'none',
            piiCategories: categories,
            reason: null,
        };
    }

    switch (result.action) {
        case 'block':
            return {
                outcome: OUTCOME.SKIPPED,
                text: null,
                piiStatus: result.reason === 'pii' ? 'found' : 'unscanned',
                piiCategories: categories,
                reason: blockReason(result, categories),
            };

        case 'tokenize':
            // The tokenised text is what gets hashed, chunked and stored. The
            // map is NOT returned — there is nothing downstream that may undo
            // this, by design.
            return {
                outcome: OUTCOME.REDACTED,
                text: result.text,
                piiStatus: 'redacted',
                piiCategories: categories,
                reason: null,
            };

        case 'ask':
            // Unreachable with allowAsk:false, and deliberately handled anyway:
            // `ask` hands back the text UNREDACTED, so a future caller that
            // forgot this would store personal data believing it was screened.
            return {
                outcome: OUTCOME.REDACTED,
                text: result.text,
                piiStatus: 'redacted',
                piiCategories: categories,
                reason: null,
            };

        default: {
            // `pass`. Two very different situations wear it: a complete clean
            // scan, and an incomplete one the org let through (fail_open).
            const incomplete = !!(result.summary?.degraded || result.summary?.truncated
                || result.summary?.overflow || result.summary?.timeout);
            if (incomplete) {
                return clean(result.text ?? text, 'unscanned', {
                    reason: incompleteReason(result),
                    piiCategories: categories,
                });
            }
            return clean(result.text ?? text, (result.findings || []).length > 0 ? 'found' : 'none', {
                piiCategories: categories,
            });
        }
    }
}

/** The category ids found, for the row's `pii_categories`. Never the values. */
function categoriesOf(result) {
    const byCategory = result?.summary?.byCategory;
    if (byCategory && typeof byCategory === 'object') {
        const keys = Object.keys(byCategory);
        if (keys.length) return keys;
    }
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    const set = new Set(findings.map(f => f?.category || f?.type).filter(Boolean));
    return set.size ? [...set] : null;
}

/**
 * Why a document was not stored — in words the person who uploaded it can act
 * on. `status_reason` is the only explanation they get, so "block" is not one.
 */
function blockReason(result, categories) {
    switch (result.reason) {
        case 'pii':
            return categories?.length
                // An org's own data type reads as the name the admin gave it.
                ? `Contains personal data (${categories.map(c => (isCustomTypeId(c) ? displayNameFor(c) : c)).join(', ')}) and this organisation does not store it`
                : 'Contains personal data and this organisation does not store it';
        case 'overflow':
            return 'Too large to check for personal data — split it into smaller documents';
        case 'timeout':
            return 'Checking for personal data did not finish in time — it will be tried again';
        case 'degraded':
            return 'Personal-data checking is temporarily unavailable — it will be tried again';
        default:
            return 'Held by the privacy policy of this organisation';
    }
}

/** Why a stored document says "unscanned" rather than "clean". */
function incompleteReason(result) {
    const s = result?.summary || {};
    if (s.degraded) return 'Personal-data checking was unavailable, so this was not checked';
    if (s.timeout) return 'Checking for personal data did not finish, so part of this was not checked';
    if (s.overflow || s.truncated) return 'Too large to check fully — only the checked part was kept';
    return 'This was not fully checked for personal data';
}

module.exports = {
    applyShield,
    scanEnabledFor,
    isLegacyWarn,
    guardInstalled,
    categoriesOf,
    blockReason,
    incompleteReason,
    OUTCOME,
    CONFIG_KEY,
};
