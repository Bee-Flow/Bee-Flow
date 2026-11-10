import type { AppDefinition } from '../inspector/appDefinition';

/** The one value `definition.serverScope` takes (server/appStudio/definitionKeys/serverScope.js). */
export const SERVER_SCOPE_WIDE = 'wide';

function hasWideServerScope(def: AppDefinition | null | undefined): boolean {
    return def?.serverScope === SERVER_SCOPE_WIDE;
}

/**
 * Switch the wide server scope on or off. Off REMOVES the key, so an app that never used it is
 * byte-identical to before.
 */
export function updateServerScope(def: AppDefinition, wide: boolean): AppDefinition {
    if (wide) return hasWideServerScope(def) ? def : { ...def, serverScope: SERVER_SCOPE_WIDE };
    if (!('serverScope' in def)) return def;
    const { serverScope: _dropped, ...rest } = def;
    return rest;
}
