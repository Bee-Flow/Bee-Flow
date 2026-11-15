/**
 * The budget step shared by scripts/theme-ratchet.mjs and scripts/vendor-name-ratchet.mjs: compare a measured count with
 * the committed budget file, refuse a rise, and with --update record a lower count (never a higher one).
 *
 * Same contract and the same verdict lines as scripts/count-ratchet.mjs (✅ under budget, ➖ at budget, ❌ over it), so
 * `check:fast --list --slack` reads these gates like any other ratchet. A missing budget file is written from the
 * measured count; `--list` without `--update` only prints and never creates one.
 *
 * Zero dependencies: node:* only. A script that imports this and is copied into a test sandbox needs this file
 * copied next to it.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} o
 * @param {string} o.root          repository root (for the paths printed)
 * @param {string} o.budgetFile    absolute path of the JSON budget file
 * @param {number} o.count         what the metric measured now
 * @param {Array<[number, string]>} o.rows  per-item counts, printed by --list
 * @param {string} o.label         the verdict line's label (a package name)
 * @param {string} o.what          plural noun phrase for the counted thing
 * @param {string} o.where         where it was counted ("under src", "in the admin namespaces")
 * @param {string} o.advice        what to do instead of raising the budget
 * @param {string} o.command       the command that lowers the budget (without --update)
 * @param {boolean} o.update
 * @param {boolean} o.list
 * @param {(line: string) => void} [o.out]
 * @param {(line: string) => void} [o.err]
 * @returns {0 | 1} the exit code
 */
export function gateBudget(o) {
    const out = o.out ?? ((l) => console.log(l));
    const err = o.err ?? ((l) => console.error(l));
    const shown = path.relative(o.root, o.budgetFile).split(path.sep).join('/');
    const existing = fs.existsSync(o.budgetFile) ? JSON.parse(fs.readFileSync(o.budgetFile, 'utf8')) : null;

    if (o.list) {
        const sorted = [...o.rows].sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
        for (const [n, item] of sorted) out(`${String(n).padStart(5)}  ${item}`);
        out('');
        if (!o.update && !existing) return 0;
    }

    if (o.update || !existing) {
        const recorded = existing ? Math.min(o.count, existing.count) : o.count;
        const body = {
            _comment: `Highest number of ${o.what} ${o.where} may still carry. Lower it with \`${o.command} --update\` after a fix; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            count: recorded,
        };
        fs.writeFileSync(o.budgetFile, `${JSON.stringify(body, null, 2)}\n`);
        out(`Budget written to ${shown}: ${recorded} ${o.what} (measured ${o.count} in ${o.rows.length} places)`);
        return 0;
    }

    const budget = existing.count;
    if (o.count > budget) {
        err(`❌ ${o.label}: ${o.count} ${o.what} ${o.where}, budget is ${budget} — ${o.advice} rather than raising the budget (\`--list\` shows where they are)`);
        return 1;
    }
    if (o.count < budget) {
        out(`✅ ${o.label}: ${o.count} ${o.what} ${o.where}, under the budget of ${budget}. Run \`${o.command} --update\` to lower it.`);
    } else {
        out(`➖ ${o.label}: ${o.count} ${o.what} ${o.where}, at budget`);
    }
    return 0;
}
