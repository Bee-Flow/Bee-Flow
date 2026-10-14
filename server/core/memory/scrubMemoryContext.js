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
async function scrubMemoryContext(text, orgShield = null, { knownEntities = [] } = {}) {
    if (!text || typeof text !== 'string') return { scrubbed: text || '', replacedCategories: [] };
    let enabledForKnown = null;

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
        enabledForKnown = enabledCategories;

        const result = await detectPii(text, enabledCategories, threshold);
        const entities = withKnownEntities(text, result?.hasPii ? result.entities : [], knownEntities, enabledCategories);
        if (!entities.length) return { scrubbed: text, replacedCategories: [] };
        return labelEntities(text, entities);
    } catch (err) {
        // The account values are known without a detector: those still go.
        const known = withKnownEntities(text, [], knownEntities, enabledForKnown);
        if (known.length) return labelEntities(text, known);
        log.warn('[ScrubMemory] PII scrub skipped (fail-open):', err.message);
        return { scrubbed: text, replacedCategories: [] };
    }
}

/**
 * Put the spans of values we already know (the user's own name, e-mail and
 * organisation, see userIdentityContext) in front of what the detector found.
 * A detected span that overlaps a known one is dropped: the known span is the
 * whole value. Only the first occurrence is placed; the tokenizer's name sweep
 * and alias index carry the token to later mentions. A category the org
 * switched off stays off.
 * @param {string} text
 * @param {Array<object>} detected
 * @param {Array<{ text: string, category: string }>} known
 * @param {string[]|null} enabledCategories
 */
function withKnownEntities(text, detected, known, enabledCategories = null) {
    const spans = [];
    for (const k of known || []) {
        if (!k?.text || (enabledCategories && !enabledCategories.includes(k.category))) continue;
        const offset = text.indexOf(k.text);
        if (offset < 0) continue;
        spans.push({ category: k.category, label: k.category, text: k.text, offset, length: k.text.length, confidenceScore: 1 });
    }
    if (!spans.length) return detected || [];
    const overlaps = (e) => spans.some((s) => typeof e.offset === 'number'
        && e.offset < s.offset + s.length && s.offset < e.offset + (e.length || 0));
    return [...spans, ...(detected || []).filter((e) => !overlaps(e))];
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

/**
 * The note that keeps a tokenised memory usable. Without it a model reads
 * "My name is [person_7]" as "the name is redacted" and tells the user it does
 * not know their name, although the un-tokeniser would have shown the real
 * value. Placed inside the <memories> block when it has one, so the note stays
 * part of the remembered data and never reads as an instruction of its own.
 * @param {string} text
 * @param {Record<string, string>} tokenMap
 */
function withTokenNote(text, tokenMap, knownEntities = []) {
    const tokens = Object.keys(tokenMap || {}).filter((t) => text.includes(t));
    if (!tokens.length) return text;
    // Say outright which placeholder is the user, so "what is my name?" in any
    // language resolves to it rather than to another person in the notes.
    const own = [];
    for (const k of knownEntities || []) {
        const want = String(k?.text || '').trim().toLowerCase();
        const tok = tokens.find((t) => String(tokenMap[t]).trim().toLowerCase() === want);
        if (tok && k.role) own.push(`\`${tok}\` is the user's ${k.role}`);
    }
    const note = `Placeholders such as ${tokens.map((t) => '`' + t + '`').join(', ')} in these notes stand for the user's own data (name, e-mail address, …); the user sees the real value. ${own.length ? own.join(', ') + '. ' : ''}When the user asks for it, answer with the placeholder verbatim, never that it is unknown.\n`;
    const close = '</memories>';
    const at = text.lastIndexOf(close);
    return at >= 0 ? text.slice(0, at) + note + text.slice(at) : text + '\n' + note;
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
async function tokenizeMemoryContext(text, orgShield = null, { conversationId = null, userId = null, deps = null, knownEntities = [] } = {}) {
    if (!text || typeof text !== 'string') return { text: text || '', tokenMap: {}, replacedCategories: [], mode: 'none' };
    if (!conversationId) {
        const { scrubbed, replacedCategories } = await scrubMemoryContext(text, orgShield, { knownEntities });
        return { text: scrubbed, tokenMap: {}, replacedCategories, mode: replacedCategories.length ? 'labels' : 'none' };
    }

    let entities;
    let d;
    let enabledCategories = null;
    try {
        d = deps || realTokenizeDeps();
        enabledCategories = (orgShield?.piiDetectionCategories?.length
            ? orgShield.piiDetectionCategories
            : d.ALL_PII_CATEGORY_IDS) || null;
        const threshold = typeof orgShield?.piiDetectionConfidenceThreshold === 'number'
            ? Math.min(orgShield.piiDetectionConfidenceThreshold, 0.70)
            : (d.DEFAULT_PII_CONFIDENCE_THRESHOLD || 0.70);
        const result = await d.detectPii(text, enabledCategories, threshold);
        const merged = withKnownEntities(text, result?.hasPii ? result.entities : [], knownEntities, enabledCategories);
        entities = d.filterAllowed ? d.filterAllowed(merged, orgShield) : merged;
        if (!entities.length) return { text, tokenMap: {}, replacedCategories: [], mode: 'none' };
    } catch (err) {
        // Same fail-open as the scrub: with no detector we cannot know what to
        // hide, except the account values, which are known without one.
        entities = withKnownEntities(text, [], knownEntities, enabledCategories);
        if (!entities.length || !d) {
            log.warn('[ScrubMemory] PII detection skipped (fail-open):', err.message);
            return { text, tokenMap: {}, replacedCategories: [], mode: 'none' };
        }
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
        return { text: withTokenNote(tokenizedText, tokenMap, knownEntities), tokenMap, replacedCategories: cats, mode: 'tokens' };
    } catch (err) {
        log.warn('[ScrubMemory] tokenising failed, using labels:', err.message);
        const { scrubbed, replacedCategories } = labelEntities(text, entities);
        return { text: scrubbed, tokenMap: {}, replacedCategories, mode: 'labels' };
    }
}

module.exports = { scrubMemoryContext, tokenizeMemoryContext, withTokenNote };
