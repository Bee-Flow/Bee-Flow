// @typecheck
/**
 * App Studio definition ids: the prefixes, the grammar and the generator.
 *
 * Shared by the server (server/appStudio/componentSpecs/ids.js re-exports it)
 * and the editor (agent-hub/src/shared/appDefinition/, a GENERATED copy made
 * by `npm run gen:shared`; never edit that copy by hand).
 */

export const ID_PREFIXES = { screen: 'scr', section: 'sec', component: 'cmp', action: 'act' };
export const ID_RE = /^(scr|sec|cmp|act)_[a-z0-9]{4,12}$/;

export function newId(kind) {
    const prefix = ID_PREFIXES[kind] || 'cmp';
    let s = '';
    while (s.length < 6) s += Math.random().toString(36).slice(2);
    return `${prefix}_${s.slice(0, 6)}`;
}
