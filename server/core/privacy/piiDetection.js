// @typecheck
/**
 * PII Detection — detect personally identifiable information in text
 *
 * Single backend: the PII Guard service (GLiNER multi-PII), a Python sidecar
 * installed via the admin dashboard. Runs locally — same Docker host, no
 * outbound calls per request. Covers all 20 categories in the picker.
 *
 * When the guard isn't installed, detectPii() returns null and the chat path
 * fails open. The admin UI surfaces this state with "Install the PII Guard
 * service to activate detection."
 *
 * Requests are shaped before they leave: text larger than one window is
 * scanned as a sequence of windows, in-flight calls are bounded, and a
 * repeatedly-failing guard is short-circuited. See "Request shaping" below —
 * that section is the fix for the intermittent "Privacy protection is
 * temporarily unavailable" that bulk pastes triggered.
 *
 * Public surface: validateInputForPii, validateOutputForPii, detectPii,
 * tokenizeText, restoreTokens, PII_CATEGORIES, ALL_PII_CATEGORY_IDS,
 * LEGACY_CATEGORY_ALIASES, DEFAULT_PII_CONFIDENCE_THRESHOLD,
 * getGuardEndpoint, invalidateGuardEndpointCache, classifyDegradation.
 *
 * The implementation lives in ./piiDetection/, split by concern — categories,
 * the guard endpoint, the guard client, request shaping, windowing, the scan
 * cache, tokenisation, restoration, detection and the policy gates. This file
 * stays the single entry point: every caller keeps requiring it, and the names
 * below are the same function objects the modules export.
 */

const {
    PII_CATEGORIES,
    ALL_PII_CATEGORY_IDS,
    LEGACY_CATEGORY_ALIASES,
    DEFAULT_PII_CONFIDENCE_THRESHOLD,
} = require('./piiDetection/categories');
const { getGuardEndpoint, invalidateGuardEndpointCache } = require('./piiDetection/guardEndpoint');
const { classifyDegradation } = require('./piiDetection/degradation');
const { MAX_REQUEST_CHARS, _resetGuardCircuit } = require('./piiDetection/requestShaping');
const {
    windowText,
    windowCountFor,
    mergeWindowResults,
    scanBudgetMs,
    _contiguousCoverage,
} = require('./piiDetection/windowing');
const { tokenizeText, _tokenCategoryKey } = require('./piiDetection/tokenizer');
const { restoreTokens, restoreTokensInRichText } = require('./piiDetection/tokenRestore');
const { neutraliseTokens } = require('./piiDetection/tokenNeutralise');
const { detectPii } = require('./piiDetection/detect');
const { validateInputForPii, validateOutputForPii } = require('./piiDetection/validate');

module.exports = {
    validateInputForPii,
    validateOutputForPii,
    detectPii,
    tokenizeText,
    // The inverse of restoreTokens for text that LEAVES its conversation: a
    // token is a key in ONE conversation's map, so anything copied out (a
    // skill example, a suggestion) must carry a readable noun instead.
    neutraliseTokens,
    // The one place a category becomes a token prefix. Exported so the
    // tokenization vault keys its entries on exactly the same string — a
    // second implementation that drifted would mean vault lookups silently
    // missing and every value getting a fresh token.
    _tokenCategoryKey,
    restoreTokens,
    restoreTokensInRichText,
    PII_CATEGORIES,
    ALL_PII_CATEGORY_IDS,
    LEGACY_CATEGORY_ALIASES,
    DEFAULT_PII_CONFIDENCE_THRESHOLD,
    getGuardEndpoint,
    invalidateGuardEndpointCache,
    classifyDegradation,
    // Test seams for the request-shaping layer above. Windowing and the breaker
    // are module state, so a test that cannot reset them is a test that depends
    // on execution order.
    windowText,
    windowCountFor,
    mergeWindowResults,
    scanBudgetMs,
    _resetGuardCircuit,
    _contiguousCoverage,
    MAX_REQUEST_CHARS,
};
