// @typecheck strict
/**
 * Regex Guardrails — pattern-based input/output content filtering
 *
 * Extracted from agentRuntime.js.
 * Validates content against named regex rules, returning matches. The rules
 * are admin-written and the content is not: every pattern runs through
 * core/text/userPattern.js (RE2, or the guarded native fallback off the
 * event loop), never a bare RegExp on the server's thread.
 */

/**
 * Check content against an array of named regex patterns.
 * @param {string|object} content - Text to check (objects are JSON-stringified)
 * @param {Array<{name: string, pattern: string}>} rulesWithPatterns - Rules to match
 * @returns {Array<{ruleName: string, pattern: string}>} Matched rules
 */
const log = require('../../telemetry/log');
const { compileUserPattern, testUserPattern } = require('../text/userPattern');
/**
 * @param {string} content
 * @param {{ name: string; pattern: string; }[] | undefined} rulesWithPatterns
 */
function checkRegexPatterns(content, rulesWithPatterns) {
    if (!rulesWithPatterns || !Array.isArray(rulesWithPatterns) || rulesWithPatterns.length === 0) {
        return [];
    }

    const textToCheck = typeof content === 'string'
        ? content
        : JSON.stringify(content);

    /** @type {{ ruleName: string; pattern: string; }[]} */
    const matches = [];
    for (const { name, pattern } of rulesWithPatterns) {
        if (!pattern || pattern.trim() === '') continue;

        const compiled = compileUserPattern(pattern);
        if (!compiled.ok) {
            log.error(`[RegexGuard] Invalid regex pattern in rule "${name}": ${compiled.message}`);
            continue;
        }
        const hit = testUserPattern(compiled, textToCheck);
        if (hit === null) {
            log.warn(`[RegexGuard] Rule "${name}" could not be decided within its time budget; skipped for this text`);
            continue;
        }
        if (hit) {
            log.warn(`[RegexGuard] Matched rule "${name}" with pattern: ${pattern}`);
            matches.push({ ruleName: name, pattern });
        }
    }
    return matches;
}

/**
 * The first rule of a guardrail configuration whose pattern cannot be run
 * (compileUserPattern refuses it), or null. The save paths use it so a rule
 * is refused where it is written.
 * @param {unknown} regexGuardrails - `{ rules: [{ name, pattern }], collections }` as stored
 * @returns {{ name: string, message: string } | null}
 */
function firstUnusableRule(regexGuardrails) {
    const rules = /** @type {{ rules?: unknown } | null} */ (regexGuardrails && typeof regexGuardrails === 'object' ? regexGuardrails : null)?.rules;
    if (!Array.isArray(rules)) return null;
    for (const rule of rules) {
        const r = /** @type {{ name?: unknown, pattern?: unknown } | null} */ (rule && typeof rule === 'object' ? rule : null);
        if (!r || r.pattern === undefined || r.pattern === null || r.pattern === '') continue;
        const compiled = compileUserPattern(r.pattern);
        if (!compiled.ok) return { name: String(r.name || '?'), message: compiled.message };
    }
    return null;
}

module.exports = {
    checkRegexPatterns,
    firstUnusableRule,
};
