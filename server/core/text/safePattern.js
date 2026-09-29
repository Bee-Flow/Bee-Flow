// @typecheck
'use strict';
/**
 * Reject regex patterns with the classic catastrophic-backtracking shape: a
 * quantifier applied to a group that itself contains a quantifier — (a+)+,
 * (\w*)+$, (a?)+ and friends. Node's regex engine backtracks exponentially on
 * those, and file_intake runs author-saved patterns against sender-controlled
 * filenames on the shared event loop, so one crafted attachment name can
 * stall every tenant on the process.
 *
 * A scanner, not a parser: escapes and character classes are skipped, and each
 * group only tracks "did I see a quantifier inside". That catches the
 * exponential nesting shape; overlap-based blowups without nesting (a|aa)+ are
 * out of its reach, and an exotic-but-safe pattern can be refused — the author
 * gets a clear validation error and rewrites. Only linear-time matching (RE2)
 * would be a guarantee; this is the dependency-free 99% of it.
 */
function hasNestedQuantifier(source) {
    const s = String(source || '');
    const stack = [];
    let current = { quant: false };
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '\\') { i += 1; continue; }
        if (ch === '[') {
            i += 1;
            while (i < s.length && s[i] !== ']') { if (s[i] === '\\') i += 1; i += 1; }
            continue;
        }
        if (ch === '(') { stack.push(current); current = { quant: false }; continue; }
        if (ch === ')') {
            const closed = current;
            current = stack.pop() || { quant: false };
            const next = s[i + 1];
            const groupQuantified = next === '*' || next === '+' || next === '?' || next === '{';
            if (groupQuantified && closed.quant) return true;
            // The parent now contains a quantifier if this group carried or
            // received one — (…(a+)…)+ nests just as fatally one level up.
            if (closed.quant || groupQuantified) current.quant = true;
            continue;
        }
        if (ch === '*' || ch === '+' || ch === '?' || ch === '{') current.quant = true;
    }
    return false;
}

module.exports = { hasNestedQuantifier };
