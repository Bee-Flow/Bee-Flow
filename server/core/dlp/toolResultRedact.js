// @typecheck
/**
 * Pure transform for the tool-RESULT DLP step (server/core/agentRuntime/chatStream.js).
 *
 * Given a serialized tool result, the PII entities detected in it, and the
 * org's block-category set for the tool's class, produce the string the model
 * should see plus the token map to merge into the conversation:
 *
 *   (b) NON-blocked PII  → reversible `[category_N]` tokens (offset-based, via
 *       tokenizeText seeded with the conversation map so counters continue and
 *       identical values reuse a token). These round-trip: restored for the user
 *       on the response stream and restored to real values if the model later
 *       passes them into another tool.
 *   (a) BLOCKED PII      → replaced with a fixed `[blocked:<category>]` marker so
 *       the model can't see it (the refuse-class policy applies to incoming data
 *       too). Done AFTER tokenization, by literal replacement — blocked values are
 *       untouched by the tokenize pass (their entities aren't passed to it), so
 *       their raw text is still present to match.
 *
 * Side-effect-free: the caller merges the returned tokenMap and writes the audit
 * log. Keeping the string surgery here makes the ordering unit-testable.
 *
 * @param {string} text                 serialized (already size-capped) result
 * @param {Array}  entities             detectPii entities ({ text, category, label, offset, length })
 * @param {Set<string>} blockCats       canonical category ids to hard-block for this tool class
 * @param {object} existingTokenMap     conversation's accumulated { token: realValue } map
 * @returns {{ content, tokenMap, redactedLabels, redactedLogLabels, blockedCount, tokenizedCount }}
 */
function redactAndTokenizeToolResult(text, entities, blockCats, existingTokenMap) {
    if (typeof text !== 'string' || !Array.isArray(entities) || entities.length === 0) {
        return { content: text, tokenMap: {}, redactedLabels: [], redactedLogLabels: [], blockedCount: 0, tokenizedCount: 0 };
    }
    const { tokenizeText, _tokenCategoryKey } = require('../privacy/piiDetection');
    const { isCustomTypeId } = require('../privacy/customTypes/ids');
    const block = blockCats instanceof Set ? blockCats : new Set(blockCats || []);

    const blocked = [];
    const tokenizable = [];
    for (const e of entities) {
        // A merged span (an org's own type that won the label over a built-in
        // category) is blocked when ANY of its categories is.
        const hit = block.has(e.category) || (Array.isArray(e.alsoCategories) && e.alsoCategories.some(c => block.has(c)));
        if (hit) blocked.push(e); else tokenizable.push(e);
    }

    let out = text;
    let tokenMap = {};
    if (tokenizable.length) {
        // Every occurrence of a blocked value stays out of the tokenize pass,
        // so the literal replacement below still finds it whole. The name
        // sweep in tokenizeText (BFSF-269) knows the conversation's people:
        // without this it could put a person token on "Hendrik" of a blocked
        // "Hendrik de Vries", and the rest of the name would reach the model.
        const reserved = [];
        for (const e of blocked) {
            if (!e.text) continue;
            for (let at = out.indexOf(e.text); at !== -1; at = out.indexOf(e.text, at + e.text.length)) {
                reserved.push({ offset: at, length: e.text.length });
            }
        }
        const r = tokenizeText(out, tokenizable, existingTokenMap || {}, { reserved });
        out = r.tokenizedText;
        tokenMap = r.tokenMap || {};
    }
    if (blocked.length) {
        // Longest value first so a shorter value that is a substring of a longer
        // one doesn't corrupt the longer replacement.
        const sorted = [...blocked].sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0));
        for (const e of sorted) {
            // The same prefix a token would get: an org's own type shows its
            // placeholder name (`[blocked:project_code]`), never its id.
            if (e.text) out = out.split(e.text).join(`[blocked:${e.category ? _tokenCategoryKey(e) : 'pii'}]`);
        }
    }

    return {
        content: out,
        tokenMap,
        redactedLabels: [...new Set(blocked.map(e => e.label))],
        // For log lines: an org's own type by id, never by its name.
        redactedLogLabels: [...new Set(blocked.map(e => (isCustomTypeId(e.category) ? e.category : e.label)))],
        blockedCount: blocked.length,
        tokenizedCount: tokenizable.length,
    };
}

module.exports = { redactAndTokenizeToolResult };
