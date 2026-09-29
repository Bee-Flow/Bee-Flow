/**
 * Nextcloud search — the unified fan-out across every registered search
 * provider, and the files-only provider search.
 */

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
async function executeSearchTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError } = ctx;

    switch (toolName) {
        case 'nextcloud_search': {
            const query = String(args.query || '').trim();
            if (!query) return { error: 'query is required' };
            const limit = Math.min(Math.max(args.limit || 5, 1), 20);
            const ocsHeaders = { 'OCS-APIRequest': 'true', 'Accept': 'application/json' };

            // Ask Nextcloud which providers exist rather than hardcoding a list:
            // every app that registers one (including apps we have never heard
            // of) becomes searchable without a Bee Flow release.
            const provRes = await ncFetch(`${baseUrl}/ocs/v2.php/search/providers?format=json`, { headers: ocsHeaders });
            if (provRes.status === 401) return { error: authError };
            if (!provRes.ok) return { error: `Could not list Nextcloud search providers (${provRes.status})` };
            const provBody = await provRes.json().catch(() => null);
            const allProviders = (provBody?.ocs?.data || [])
                .map(p => ({ id: p.id, name: p.name }))
                .filter(p => p.id);

            const wanted = Array.isArray(args.providers) && args.providers.length
                ? allProviders.filter(p => args.providers.includes(p.id))
                : allProviders;
            if (!wanted.length) {
                return {
                    query,
                    count: 0,
                    results: [],
                    availableProviders: allProviders.map(p => p.id),
                    note: 'None of the requested providers exist on this Nextcloud.',
                };
            }

            // Fan out concurrently; one slow or broken provider must not sink
            // the whole search, so failures are collected rather than thrown.
            const settled = await Promise.allSettled(wanted.map(async (p) => {
                const url = `${baseUrl}/ocs/v2.php/search/providers/${encodeURIComponent(p.id)}/search`
                    + `?term=${encodeURIComponent(query)}&limit=${limit}&format=json`;
                const r = await ncFetch(url, { headers: ocsHeaders });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const body = await r.json().catch(() => null);
                const entries = body?.ocs?.data?.entries || [];
                return entries.map(e => ({
                    provider: p.id,
                    providerName: p.name,
                    title: e.title || '',
                    subline: e.subline || '',
                    link: e.resourceUrl || e.link || null,
                    icon: e.icon || null,
                    // Upstream's files provider populates attributes.path/fileId.
                    // Dropping them meant a files hit carried nothing that could
                    // place it inside a folder selection, so EVERY file result
                    // was filtered out of the one search tool whose description
                    // tells the model to prefer it.
                    path: e.attributes?.path ?? null,
                    fileId: e.attributes?.fileId ?? null,
                }));
            }));

            const results = [];
            const failed = [];
            settled.forEach((r, i) => {
                if (r.status === 'fulfilled') results.push(...r.value);
                else failed.push(wanted[i].id);
            });
            return {
                query,
                count: results.length,
                results,
                availableProviders: allProviders.map(p => p.id),
                ...(failed.length ? { providersUnavailable: failed } : {}),
            };
        }

        case 'nextcloud_search_files': {
            const limit = Math.min(Math.max(args.limit || 25, 1), 100);
            const query = String(args.query || '').trim();
            if (!query) return { error: 'query is required' };
            // OCS Files API search endpoint (works on Nextcloud 12+).
            const url = `${baseUrl}/ocs/v2.php/search/providers/files/search?term=${encodeURIComponent(query)}&limit=${limit}&format=json`;
            const res = await ncFetch(url, {
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Nextcloud search failed (${res.status})` };
            const data = await res.json();
            const entries = data?.ocs?.data?.entries || [];
            return {
                query,
                count: entries.length,
                items: entries.slice(0, limit).map(e => ({
                    name: e.title,
                    path: e.attributes?.path || (e.resourceUrl || '').split('dir=').pop() || null,
                    subline: e.subline || null,
                    url: e.resourceUrl || null,
                })),
            };
        }

        default:
            return undefined;
    }
}

module.exports = { executeSearchTool };
