import type { AppDefinition } from '../inspector/appDefinition';

/** Mirror of LIMITS.MAX_ALLOWED_LINK_HOSTS (server/appStudio/componentSpecs/limits.js). */
export const MAX_ALLOWED_LINK_HOSTS = 50;
const HOST_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789.-';

/** True for a bare host name: host characters only, no empty label, no dash at the edge of a label. */
export function isBareHost(host: string): boolean {
    if (!host || host.length > 253) return false;
    for (const ch of host) if (!HOST_CHARS.includes(ch)) return false;
    return host.split('.').every((label) => label !== '' && !label.startsWith('-') && !label.endsWith('-'));
}

/** The hosts typed in a box (one per line or comma-separated), lowercased and split into kept and refused. */
export function parseLinkHosts(text: string): { hosts: string[]; refused: string[] } {
    const hosts: string[] = [];
    const refused: string[] = [];
    for (const line of text.split('\n')) {
        for (const part of line.split(',')) {
            const host = part.trim().toLowerCase();
            if (!host) continue;
            if (!isBareHost(host)) refused.push(host);
            else if (!hosts.includes(host)) hosts.push(host);
        }
    }
    return { hosts: hosts.slice(0, MAX_ALLOWED_LINK_HOSTS), refused };
}

/**
 * Set the hosts an open_url formula may open. An empty list REMOVES the key, so an app that never used it
 * is byte-identical to before. Human-set only: the builder tools have no way to write this key.
 */
export function updateAllowedLinkHosts(def: AppDefinition, hosts: string[]): AppDefinition {
    const current = Array.isArray(def.allowedLinkHosts) ? (def.allowedLinkHosts as string[]) : [];
    if (current.length === hosts.length && current.every((h, i) => h === hosts[i])) return def;
    if (!hosts.length) {
        if (!('allowedLinkHosts' in def)) return def;
        const { allowedLinkHosts: _dropped, ...rest } = def;
        return rest;
    }
    return { ...def, allowedLinkHosts: hosts };
}
