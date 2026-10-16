import { INTEGRATION_LOGOS } from '../../utils/integrationLogos';

/** Lowercase letters and digits only, so "Outlook (read-only)" meets `outlook_readonly`. */
const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

let byCompact: Map<string, string> | null = null;

function registryIndex(): Map<string, string> {
    if (!byCompact) {
        byCompact = new Map();
        for (const id of Object.keys(INTEGRATION_LOGOS)) byCompact.set(compact(id), id);
    }
    return byCompact;
}

/**
 * The registry id of the brand mark for an integration tile. An explicit
 * `logoId` wins; a tile that left it empty is matched on its label and then
 * on its icon name, so content written without ids still gets its logo.
 * Returns undefined when the registry has no mark for it.
 */
export function resolveIntegrationLogoId(item: { logoId?: string; label?: string; icon?: string }): string | undefined {
    if (item.logoId) return item.logoId;
    const index = registryIndex();
    for (const candidate of [item.label, item.icon]) {
        const hit = candidate ? index.get(compact(candidate)) : undefined;
        if (hit) return hit;
    }
    return undefined;
}
