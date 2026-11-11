/**
 * App Studio builder tool app_set_shell (tools/app_set_shell.js): the shell options of
 * definition.nav (navShell.mts): the nav style, a hidden top bar, the app's own links, a footer
 * line and the brand. Each key that is passed replaces the stored one; null removes it (for
 * `style`: back to tabs). The echo is the nav as STORED, so the model sees what saving kept.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const ops = nodeRequire('../definitionOps.js') as { updateNav: (def: unknown, patch: Record<string, unknown> | null) => unknown };
const { adoptCanonical } = nodeRequire('./shared.js') as { adoptCanonical: (wrap: DraftWrap, next: unknown, result: Record<string, unknown>) => Record<string, unknown> };
const { NAV_STYLES, NAV_DEFAULT_STYLE } = nodeRequire('../appDesignSpec.js') as { NAV_STYLES: readonly string[]; NAV_DEFAULT_STYLE: string };

type DraftWrap = { def: Record<string, unknown> };

export const SHELL_KEYS: readonly string[] = Object.freeze(['style', 'header', 'items', 'footerText', 'brand']);

export function apply(draftWrap: DraftWrap, args: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const key of SHELL_KEYS) {
        if (!args || args[key] === undefined) continue;
        patch[key] = key === 'style' && args[key] === null ? NAV_DEFAULT_STYLE : args[key];
    }
    if (!Object.keys(patch).length) {
        return { error: `Pass at least one of: ${SHELL_KEYS.join(', ')}.`, _fixHint: 'e.g. app_set_shell { header: "hidden" } or { style: "none" }.' };
    }
    if (typeof patch.style === 'string' && !NAV_STYLES.includes(patch.style)) {
        return { error: `Unknown style ${JSON.stringify(patch.style)}. Legal: ${NAV_STYLES.join(', ')}.`, _fixHint: 'Pick one of the listed styles.' };
    }
    const nav = draftWrap.def.nav && typeof draftWrap.def.nav === 'object' ? draftWrap.def.nav as Record<string, unknown> : {};
    const next = ops.updateNav(draftWrap.def, { ...nav, ...patch });
    const result = adoptCanonical(draftWrap, next, {});
    if (result.error) return result;
    result.nav = draftWrap.def.nav ? { ...(draftWrap.def.nav as Record<string, unknown>) } : null;
    return result;
}
