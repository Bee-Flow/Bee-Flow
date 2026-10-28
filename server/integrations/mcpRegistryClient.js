// @typecheck noImplicitAny
/**
 * mcpRegistryClient.js — read-only client for the OFFICIAL, open MCP Registry
 * (registry.modelcontextprotocol.io). No API key, no third-party SaaS — this
 * is the community/canonical registry, so the marketplace's "Browse all" tab
 * stays fully open-source with no vendor lock-in.
 *
 * Two responsibilities:
 *   1. `searchOfficial({ q, cursor })` — fetch + paginate the public list.
 *   2. `registryEntryToInstallConfig(entry)` — map a registry `server.json`
 *      entry to the install shape our `POST /ai/mcp-servers` flow expects
 *      (command/args/transport/url/required_credentials), or flag it
 *      `viewOnly` when nothing is installable.
 *
 * The mapper + helpers are pure and exported so they can be unit-tested with a
 * scripted `global.fetch` (see mcpRegistryClient.test.js), mirroring the
 * afasTools.test.js pattern.
 */

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * The parts of an official-registry `server.json` entry the mapper reads.
 * @typedef {string | { type?: string, name?: string, value?: unknown, default?: unknown } | null} RegistryArg
 * @typedef {{ name?: string, isSecret?: boolean, isRequired?: boolean, is_secret?: boolean, is_required?: boolean } | null} RegistryEnvVar
 * @typedef {{ registryType?: string, registry_type?: string, identifier?: string, name?: string, version?: string,
 *   environmentVariables?: RegistryEnvVar[], environment_variables?: RegistryEnvVar[],
 *   runtimeArguments?: RegistryArg[], runtime_arguments?: RegistryArg[],
 *   packageArguments?: RegistryArg[], package_arguments?: RegistryArg[] }} RegistryPackage
 * @typedef {{ name?: string, title?: string, description?: string, repository?: { url?: string }, version?: string,
 *   packages?: RegistryPackage[], remotes?: Array<{ type: string, url?: string }> }} RegistryServer
 * @typedef {RegistryServer & { server?: RegistryServer,
 *   _meta?: Record<string, { status?: string, isLatest?: boolean }> }} RegistryEntry
 * @typedef {{ name: string, registryName: string, description: string, repository: string | null, homepage: string | null,
 *   version: string | null, icon: string, category: string, source: string, verified: boolean, installable: boolean,
 *   viewOnly: boolean, transport?: string, command?: string | null, args?: string[], url?: string,
 *   required_credentials?: Array<{ key: string, label: string }>, reason?: string }} RegistryInstallConfig
 */

// ── helpers (pure) ──────────────────────────────────────────────────────

/** @param {RegistryPackage | null | undefined} pkg */
function regType(pkg) {
    return pkg && (pkg.registryType || pkg.registry_type);
}

/**
 * Prefer npm (npx) → pypi (uvx) → oci (docker) → first available.
 * @param {RegistryPackage[] | null | undefined} packages
 */
function pickPackage(packages) {
    if (!Array.isArray(packages) || packages.length === 0) return null;
    /**
     * @param {string} t
     */
    const byType = (t) => packages.find(p => regType(p) === t);
    return byType('npm') || byType('pypi') || byType('oci') || packages[0];
}

/** @param {unknown} name */
function humanize(name) {
    return String(name || '')
        .replace(/[_\-.]+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** @param {RegistryPackage} pkg */
function identWithVersion(pkg) {
    const id = pkg.identifier || pkg.name || '';
    const v = pkg.version;
    return (v && v !== 'latest') ? `${id}@${v}` : id;
}

/**
 * Flatten registry runtime/package argument descriptors to an argv array.
 * Each item is either a bare string or `{ type:'positional'|'named', name?, value?, default? }`.
 * @param {RegistryArg[] | null | undefined} argList
 */
function argTokens(argList) {
    /** @type {string[]} */
    const out = [];
    for (const a of argList || []) {
        if (a == null) continue;
        if (typeof a === 'string') { out.push(a); continue; }
        const value = (a.value != null && a.value !== '') ? a.value
            : (a.default != null && a.default !== '') ? a.default
                : null;
        if (a.type === 'named' && a.name) {
            out.push(a.name);
            if (value != null) out.push(String(value));
        } else if (value != null) {
            out.push(String(value));
        }
    }
    return out;
}

/**
 * Surface only the env vars a user must supply (secret or required) as credentials.
 * @param {RegistryEnvVar[] | null | undefined} envVars
 */
function credsFromEnv(envVars) {
    return (envVars || [])
        .filter(v => v && v.name && (v.isSecret || v.isRequired || v.is_secret || v.is_required))
        .map(v => ({ key: v.name, label: humanize(v.name) }));
}

/** @param {RegistryEntry | null | undefined} entry */
function officialMeta(entry) {
    return entry && entry._meta && entry._meta['io.modelcontextprotocol.registry/official'] || null;
}

/**
 * True when the entry is the active, latest published version (used for verified-only filtering).
 * @param {RegistryEntry | null | undefined} entry
 */
function isActiveLatest(entry) {
    const m = officialMeta(entry);
    if (!m) return false;
    return m.status === 'active' && m.isLatest !== false;
}

/**
 * Map an official-registry entry (`{ server, _meta }` or a bare `server`) to our
 * install config. Returns null for garbage, or `{ ...meta, installable:false,
 * viewOnly:true }` when no package/remote can be installed.
 *
 * @param {RegistryEntry | null | undefined} entry
 * @returns {RegistryInstallConfig | null}
 */
function registryEntryToInstallConfig(entry) {
    const s = (entry && entry.server) ? entry.server : entry;
    if (!s || !s.name) return null;

    const meta = officialMeta(entry);
    const repository = (s.repository && s.repository.url) || null;
    /** @type {RegistryInstallConfig} */
    const base = {
        name: s.title || s.name,
        registryName: s.name,
        description: s.description || '',
        repository,
        homepage: repository,
        version: s.version || null,
        icon: '🧩',
        category: 'registry',
        source: 'registry',
        verified: meta ? meta.status === 'active' : false,
        installable: true,
        viewOnly: false,
    };

    const pkg = pickPackage(s.packages);
    const type = regType(pkg);
    const env = pkg && (pkg.environmentVariables || pkg.environment_variables);

    if (pkg && type === 'npm') {
        base.transport = 'stdio';
        base.command = 'npx';
        base.args = ['-y', identWithVersion(pkg), ...argTokens(pkg.runtimeArguments || pkg.runtime_arguments), ...argTokens(pkg.packageArguments || pkg.package_arguments)];
        base.required_credentials = credsFromEnv(env);
    } else if (pkg && type === 'pypi') {
        base.transport = 'stdio';
        base.command = 'uvx';
        base.args = [identWithVersion(pkg), ...argTokens(pkg.packageArguments || pkg.package_arguments)];
        base.required_credentials = credsFromEnv(env);
    } else if (pkg && type === 'oci') {
        base.transport = 'stdio';
        base.command = 'docker';
        base.args = ['run', '-i', '--rm', identWithVersion(pkg)];
        base.required_credentials = credsFromEnv(env);
    } else if (Array.isArray(s.remotes) && s.remotes.length > 0) {
        const r = s.remotes.find((/** @type {{ type: string; }} */ x) => x.type === 'streamable-http') || s.remotes.find((/** @type {{ type: string; }} */ x) => x.type === 'sse') || s.remotes[0];
        base.transport = 'http';
        base.url = r.url;
        base.command = null;
        base.required_credentials = [];
    } else {
        return { ...base, installable: false, viewOnly: true, reason: 'no_installable_package' };
    }

    return base;
}

// ── network (impure) ────────────────────────────────────────────────────

/** @typedef {{ q?: string, cursor?: string, limit?: number, timeoutMs?: number }} SearchOfficialArgs */
/**
 * Fetch one page of the official registry. Returns `{ servers, nextCursor }`.
 * `servers` are raw `{ server, _meta }` entries (map them with
 * registryEntryToInstallConfig).
 * @param {SearchOfficialArgs} [param0]
 */
async function searchOfficial({ q = '', cursor = '', limit = 50, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (q) params.set('search', q);
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${REGISTRY_URL}?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`MCP registry HTTP ${res.status}`);
    const data = /** @type {{ servers?: object[], metadata?: { next_cursor?: string, nextCursor?: string }, nextCursor?: string }} */ (await res.json());
    const servers = Array.isArray(data.servers) ? data.servers : [];
    const nextCursor = (data.metadata && (data.metadata.next_cursor || data.metadata.nextCursor)) || data.nextCursor || null;
    return { servers, nextCursor };
}

module.exports = {
    searchOfficial,
    registryEntryToInstallConfig,
    isActiveLatest,
    // exported for tests
    pickPackage,
    argTokens,
    credsFromEnv,
    humanize,
    identWithVersion,
};
