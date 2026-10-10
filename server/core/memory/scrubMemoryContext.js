/**
 * Scrub an assembled memory-context string of any PII the Azure detector can
 * find. This is the read-time guard against the "memory leak" class of bug:
 * a user mentions an IBAN in turn 1, the memory extractor stores the full
 * value, then turn 2's memory-retrieval injects that value into the system
 * prompt — bypassing the per-turn tokeniser entirely.
 *
 * Strategy: replace each detected span with a generic human-readable label
 * (`[User's IBAN]`, `[User's email]`, …) rather than a round-trip token. The
 * LLM still sees context ("the user has an IBAN") without ever learning the
 * value. No token-map → no restoration needed → no leak path.
 *
 * Intentionally fail-open: if the detector is unavailable or the config says
 * PII is disabled, we leave the memory untouched. This mirrors how the main
 * PII path behaves in guardrailsRunner — availability issues shouldn't brick
 * the whole chat surface.
 */
const log = require('../../telemetry/log');
const { isCustomTypeId } = require('../privacy/customTypes/ids');
const { displayNameFor } = require('../privacy/customTypes/registry');

const CATEGORY_LABELS = {
    Email:                            "User's email address",
    PhoneNumber:                      'phone number',
    Person:                           'name',
    PersonType:                       'role',
    Address:                          'address',
    Age:                              'age',
    DateOfBirth:                      'date of birth',
    CreditCardNumber:                 'credit card number',
    BankAccountNumber:                'bank account number',
    InternationalBankingAccountNumber:'IBAN',
    ABARoutingNumber:                 'ABA routing number',
    SWIFTCode:                        'SWIFT code',
    USSocialSecurityNumber:           'SSN',
    PassportNumber:                   'passport number',
    DriversLicenseNumber:             'drivers licence number',
    NationalID:                       'national ID',
    IPAddress:                        'IP address',
    URL:                              'URL',
    Organization:                     'organisation',
    AzureCredentialKey:               'Azure credential',
};

function humaniseLabel(category) {
    // An org's own data type ("Your own data") reads as the name its admin
    // gave it: the model learns "there was a project code here", not the code.
    if (isCustomTypeId(category)) return displayNameFor(category);
    return CATEGORY_LABELS[category] || 'sensitive value';
}

/**
 * @param {string} text
 * @param {object} orgShield
 * @returns {Promise<{ scrubbed: string, replacedCategories: string[] }>}
 */
async function scrubMemoryContext(text, orgShield = null) {
    if (!text || typeof text !== 'string') return { scrubbed: text || '', replacedCategories: [] };

    try {
        const { detectPii, ALL_PII_CATEGORY_IDS, DEFAULT_PII_CONFIDENCE_THRESHOLD } =
            require('../privacy/piiDetection');

        // Respect the org's category selection and threshold; fall back to
        // platform defaults. Deliberately lower the threshold slightly so we
        // err on the side of over-scrubbing stored memories — this is not an
        // outbound prompt gate, it's defence-in-depth against leakage.
        const enabledCategories = (orgShield?.piiDetectionCategories?.length
            ? orgShield.piiDetectionCategories
            : ALL_PII_CATEGORY_IDS) || null;
        const threshold = typeof orgShield?.piiDetectionConfidenceThreshold === 'number'
            ? Math.min(orgShield.piiDetectionConfidenceThreshold, 0.70)
            : (DEFAULT_PII_CONFIDENCE_THRESHOLD || 0.70);

        const result = await detectPii(text, enabledCategories, threshold);
        if (!result?.hasPii || !result.entities?.length) {
            return { scrubbed: text, replacedCategories: [] };
        }

        return labelEntities(text, result.entities);
    } catch (err) {
        log.warn('[ScrubMemory] PII scrub skipped (fail-open):', err.message);
        return { scrubbed: text, replacedCategories: [] };
    }
}

/** Splice generic labels over detected spans (tail first, so offsets stay valid). */
function labelEntities(text, entities) {
    const sorted = [...entities].sort((a, b) => b.offset - a.offset);
    let scrubbed = text;
    const seen = new Set();
    for (const entity of sorted) {
        const label = humaniseLabel(entity.category);
        const replacement = `[${label}]`;
        if (typeof entity.offset === 'number' && entity.offset >= 0) {
            scrubbed = scrubbed.slice(0, entity.offset) + replacement + scrubbed.slice(entity.offset + entity.length);
        } else if (entity.text) {
            scrubbed = scrubbed.split(entity.text).join(replacement);
        }
        seen.add(label);
    }
    return { scrubbed, replacedCategories: [...seen] };
}

function realTokenizeDeps() {
    const pii = require('../privacy/piiDetection');
    return {
        detectPii: pii.detectPii,
        tokenizeText: pii.tokenizeText,
        ALL_PII_CATEGORY_IDS: pii.ALL_PII_CATEGORY_IDS,
        DEFAULT_PII_CONFIDENCE_THRESHOLD: pii.DEFAULT_PII_CONFIDENCE_THRESHOLD,
        dlpRunner: require('../dlp/dlpRunner'),
        buildSeed: (userId, entities, existing) => require('../../stores/piiVaultStore').buildSeed(userId, entities, existing),
        filterAllowed: (entities, shield) => {
            const { buildAllowMatcher, filterAllowedEntities } = require('../dlp/allowTerms');
            return filterAllowedEntities(entities, buildAllowMatcher(shield || {})).entities;
        },
    };
}

/**
 * Reversible variant of scrubMemoryContext for a turn that has a conversation.
 *
 * The scrub above replaces a name with `[User's name]`, so the model answers
 * "your name is not known" to a user whose memory says "My name is tom".
 * Chat messages use reversible conversation tokens (`[person_1]`) that the
 * streaming un-tokeniser turns back into the value; the memory block does the
 * same here: tokens are minted with the vault's stable numbering and merged
 * into the conversation map, so the token-preservation addendum lists them and
 * the answer the user sees carries the real value.
 *
 * Without a conversation id there is nothing to restore with: the label scrub
 * runs. If detection worked but tokenising did not, the label scrub is the
 * fallback; the raw value is never sent on that path.
 *
 * @returns {Promise<{ text: string, tokenMap: object, replacedCategories: string[], mode: 'tokens'|'labels'|'none' }>}
 */
async function tokenizeMemoryContext(text, orgShield = null, { conversationId = null, userId = null, deps = null } = {}) {
    if (!text || typeof text !== 'string') return { text: text || '', tokenMap: {}, replacedCategories: [], mode: 'none' };
    if (!conversationId) {
        const { scrubbed, replacedCategories } = await scrubMemoryContext(text, orgShield);
        return { text: scrubbed, tokenMap: {}, replacedCategories, mode: replacedCategories.length ? 'labels' : 'none' };
    }

    let entities;
    let d;
    try {
        d = deps || realTokenizeDeps();
        const enabledCategories = (orgShield?.piiDetectionCategories?.length
            ? orgShield.piiDetectionCategories
            : d.ALL_PII_CATEGORY_IDS) || null;
        const threshold = typeof orgShield?.piiDetectionConfidenceThreshold === 'number'
            ? Math.min(orgShield.piiDetectionConfidenceThreshold, 0.70)
            : (d.DEFAULT_PII_CONFIDENCE_THRESHOLD || 0.70);
        const result = await d.detectPii(text, enabledCategories, threshold);
        if (!result?.hasPii || !result.entities?.length) return { text, tokenMap: {}, replacedCategories: [], mode: 'none' };
        entities = d.filterAllowed ? d.filterAllowed(result.entities, orgShield) : result.entities;
        if (!entities.length) return { text, tokenMap: {}, replacedCategories: [], mode: 'none' };
    } catch (err) {
        // Same fail-open as the scrub: with no detector we cannot know what to hide.
        log.warn('[ScrubMemory] PII detection skipped (fail-open):', err.message);
        return { text, tokenMap: {}, replacedCategories: [], mode: 'none' };
    }

    try {
        const { dlpRunner } = d;
        // Hydrate first: a merge into a cold map would be skipped by the later
        // hydration and the numbering would restart at 1.
        let existing = {};
        try { existing = (await dlpRunner.getConversationTokenMapAsync(conversationId)) || {}; }
        catch (_) { existing = dlpRunner.getConversationTokenMap(conversationId) || {}; }
        const seed = userId
            ? await d.buildSeed(userId, entities, existing)
            : { tokenMap: { ...existing }, counterFloors: {} };
        const { tokenizedText, tokenMap } = d.tokenizeText(text, entities, seed.tokenMap, { counterFloors: seed.counterFloors });
        if (!tokenMap || Object.keys(tokenMap).length === 0 || tokenizedText === text) throw new Error('nothing tokenised');
        dlpRunner.mergeTokenMap(conversationId, tokenMap);
        const cats = [...new Set(entities.map((e) => humaniseLabel(e.category)))];
        return { text: tokenizedText, tokenMap, replacedCategories: cats, mode: 'tokens' };
    } catch (err) {
        log.warn('[ScrubMemory] tokenising failed, using labels:', err.message);
        const { scrubbed, replacedCategories } = labelEntities(text, entities);
        return { text: scrubbed, tokenMap: {}, replacedCategories, mode: 'labels' };
    }
}

module.exports = { scrubMemoryContext, tokenizeMemoryContext };
