// @typecheck strict
/**
 * The capability vocabulary — one entry per outward surface the sandbox
 * actually gates, spelled the way codeSandbox gates it, and mapped to the
 * bridge that does the gating:
 *
 *   tool:<name>  ctx.integrations.<name>(args)  → bridges.executeTool, refused
 *                                                 unless <name> is in
 *                                                 bridges.allowedTools
 *   http         ctx.http(url, opts)            → bridges.fetchHttp
 *   db           ctx.db.query/exec/batch        → bridges.db
 *   secrets      ctx.secrets(name)              → no bridge at all; throws
 *
 * The mapping is the point, not decoration: a word that names no bridge names
 * nothing anyone enforces, and a manifest of such words is a promise with no
 * keeper. customNode.test.js pins this table against the bridges codeSandbox
 * really builds, so a fifth outward surface cannot be added there and quietly
 * stay undeclarable here.
 */
const CAPABILITY_BRIDGES = Object.freeze({
    tool: 'executeTool',
    http: 'fetchHttp',
    db: 'db',
    secrets: null,
});

// Tool names as the catalog spells them (gmail_send, nextcloud_list_files).
// Bounded because the manifest is stored, shipped and shown.
const TOOL_CAPABILITY_RE = /^tool:([A-Za-z0-9][A-Za-z0-9_.-]{0,79})$/;

/**
 * One manifest entry → { kind, tool } , or null when it is not a capability.
 * @param {unknown} raw
 *
 * A bare `tool` is null on purpose: the sandbox gates per tool NAME, so
 * "tool" grants nothing that can be checked and would read as if it granted
 * all of them.
 */
function parseCapability(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    const m = TOOL_CAPABILITY_RE.exec(s);
    if (m) return { kind: 'tool', tool: m[1] };
    if (s !== 'tool' && Object.prototype.hasOwnProperty.call(CAPABILITY_BRIDGES, s)) {
        return { kind: s, tool: null };
    }
    return null;
}

/**
 * Canonical spelling of one parsed capability — what the manifest stores.
 * @param {{ kind: string, tool: string | null }} cap
 */
function capabilityId(cap) {
    return cap.kind === 'tool' ? `tool:${cap.tool}` : cap.kind;
}

/**
 * The declared manifest, normalized: recognised entries only, deduped, in
 * declaration order. Same division of labour as appTriggerContract — the
 * readers get the usable half, validateCustomNode reports the junk.
 * @param {{ capabilities?: unknown } | null | undefined} definition
 */
function declaredCapabilities(definition) {
    const raw = definition?.capabilities;
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        const cap = parseCapability(entry);
        if (!cap) continue;
        const id = capabilityId(cap);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...cap, id });
    }
    return out;
}

/**
 * The tool names the manifest declares, sorted unique.
 * @param {{ capabilities?: unknown } | null | undefined} definition
 */
function capabilityToolNames(definition) {
    return [...new Set(declaredCapabilities(definition).filter(c => c.kind === 'tool').map(c => c.tool))].sort();
}

module.exports = { CAPABILITY_BRIDGES, TOOL_CAPABILITY_RE, parseCapability, declaredCapabilities, capabilityToolNames };
