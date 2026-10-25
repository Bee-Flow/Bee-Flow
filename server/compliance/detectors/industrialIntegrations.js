// @typecheck strict
/**
 * Industrial-integration detector — the automated half of the Machinery
 * Regulation checks (MACHINERY-Art3-industrial-detection feeds on it,
 * MACHINERY-Art18-safety-component-assessment takes its matches as subjects).
 *
 * Software that controls or monitors a machine's safety function is a
 * "safety component" under Regulation (EU) 2023/1230 Art. 3(3). The platform
 * cannot know what a customer's automation drives, but it can see the
 * fingerprints of industrial protocols and vendors in what the org has
 * configured and where its traffic went. This module scans five sources and
 * returns a list of candidates with the signals that triggered them — a
 * prompt to assess, never a verdict.
 *
 *   detect(orgId) → {
 *     scanned: { custom_integrations, automations, connections, activity_hosts, mcp_servers },
 *     matches: [{ source, id, label, signals: [{ kind: 'scheme'|'port'|'host'|'keyword', value }], confidence: 'high'|'low', scope? }],
 *     skipped: [{ source, reason }],     // tables/columns not provisioned
 *     heuristics_version,
 *   }
 *
 * Signals (§4.5 of the check catalogue):
 *   • scheme   — opc.tcp://, mqtt(s)://, modbus://, s7://, ads://, coap(s)://,
 *                ethernet-ip:// / enip://, bacnet://, dnp3://, iec104://      → high (mqtt → low)
 *   • port     — an explicit host:port on a well-known industrial port
 *                502 Modbus · 4840 OPC UA · 1883/8883 MQTT · 102 S7 · 44818 EtherNet/IP ·
 *                20000 DNP3 · 47808 BACnet · 48898 Beckhoff ADS · 2404 IEC-104   → high (MQTT ports → low)
 *   • host     — vendor cloud hosts (MindSphere / Insights Hub, ThingWorx,
 *                Ignition)                                                       → high
 *   • keyword  — protocol / vendor vocabulary in names, descriptions, tool names → low
 *
 * Port matching is exact on the parsed port, so https://api.example.com:5020
 * is not Modbus (502) and a bare number in prose is never a port.
 *
 * Sources (all org-scoped except mcp_servers, which is a platform-wide admin
 * table without an org column — those matches carry scope:'platform'):
 *   org_custom_integrations (definition + activated_definition), automations
 *   (definition_json walked with automation/automationGraph.walkSteps when present),
 *   integration_connections.provider/label, integration_activity_log
 *   server_endpoint/tls_servername/dest_host over 90 days, mcp_servers url/command.
 *
 * Evidence hygiene: labels are integration/automation/connection names and
 * ids; URL userinfo is stripped from every signal value; no user ids, no
 * e-mail addresses.
 */

const db = require('../../db');
const { errorLabel } = require('../lib/errorShape');
const { bestEffort } = require('../../utils/bestEffort');
const { HEURISTICS_VERSION, ACTIVITY_WINDOW_DAYS, ROW_CAP, MAX_TEXT, SCHEMES, PORTS, NON_INDUSTRIAL_SCHEMES, VENDOR_HOST_RE, KEYWORD_RE, URL_RE, HOSTPORT_RE, _isNotProvisioned, _hostAndPort, _canonicalKeyword, _safeString } = require('./industrialIntegrationsStripUserinfo');

/**
 * Scan free text (names, descriptions, stringified definitions) for the
 * signals above. Returns deduplicated signals.
 *
 * @param {string} text
 * @param {{ keywords?: boolean }} [opts]  keywords default true
 */
function scanText(text, opts = {}) {
    const src = _safeString(text).slice(0, MAX_TEXT);
    /** @type {{ kind: string; value: string; }[]} */
    const signals = [];
    const seen = new Set();
    /**
     * @param {string} kind
     * @param {string} value
     */
    const add = (kind, value) => {
        const key = `${kind}:${value}`;
        if (seen.has(key)) return;
        seen.add(key);
        signals.push({ kind, value });
    };

    // URLs: scheme + port + vendor host.
    /** @type {number[][]} */
    const urlSpans = [];
    for (const m of src.matchAll(URL_RE)) {
        urlSpans.push([m.index, m.index + m[0].length]);
        const scheme = m[1].toLowerCase();
        const { host, port } = _hostAndPort(m[2]);
        if (SCHEMES[scheme]) add('scheme', `${scheme}://${host}${port ? `:${port}` : ''}`);
        // A port inside a URL whose scheme names a non-industrial protocol is
        // that protocol's port, whatever number it has (sftp://host:2222).
        if (port !== null && PORTS[port] && !NON_INDUSTRIAL_SCHEMES.has(scheme)) add('port', `${host}:${port}`);
        if (host && VENDOR_HOST_RE.test(host)) add('host', host);
    }

    // Bare host:port pairs that were not part of a URL.
    for (const m of src.matchAll(HOSTPORT_RE)) {
        const start = m.index + m[0].indexOf(m[1]);
        if (urlSpans.some(([a, b]) => start >= a && start < b)) continue;
        const port = Number(m[2]);
        if (!PORTS[port]) continue;
        const host = m[1].toLowerCase();
        // A hostname must have a dot or be an IP literal to count as a host.
        if (!/\d+\.\d+\.\d+\.\d+/.test(host) && !host.includes('.')) continue;
        add('port', `${host}:${port}`);
    }

    // Vendor hosts appearing without a scheme (e.g. in a JSON "host" field).
    for (const m of src.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
        const host = m[1].toLowerCase();
        if (VENDOR_HOST_RE.test(host)) add('host', host);
    }

    if (opts.keywords !== false) {
        // Tool ids and identifiers join words with underscores (kepware_read_tag,
        // siemens_diag) — treat them as separators so \b sees the vocabulary.
        for (const m of src.replace(/_/g, ' ').matchAll(KEYWORD_RE)) add('keyword', _canonicalKeyword(m[1]));
    }
    return signals;
}

/**
 * high when any non-MQTT scheme, non-MQTT industrial port or vendor host
 * fired; MQTT (scheme or port) and keywords alone stay low — MQTT is generic
 * IoT plumbing, not a machine-safety fingerprint by itself.
 * @param {{ kind: string; value: string; }[]} signals
 */
function confidenceOf(signals) {
    for (const s of signals) {
        if (s.kind === 'host') return 'high';
        if (s.kind === 'port') {
            const port = Number(s.value.slice(s.value.lastIndexOf(':') + 1));
            if (PORTS[port] && PORTS[port].confidence === 'high') return 'high';
        }
        if (s.kind === 'scheme') {
            const scheme = s.value.split('://')[0];
            if (SCHEMES[scheme] && SCHEMES[scheme].confidence === 'high') return 'high';
        }
    }
    return 'low';
}

// ── automation definitions ──────────────────────────────────────────────────

/**
 * Minimal step walker used when automation/automationGraph.js (another workstream)
 * is not on disk yet: flattens steps, loop/forEach bodies, parallel branches
 * and condition arms.
 * @param {Record<string, any> | null | undefined} definition
 * @param {(step: Record<string, any>) => void} fn
 */
function _fallbackWalkSteps(definition, fn) {
    const seen = new Set();
    /** @param {Record<string, any>[] | undefined} list */
    const walk = (list) => {
        for (const s of (Array.isArray(list) ? list : [])) {
            if (!s || typeof s !== 'object' || seen.has(s)) continue;
            seen.add(s);
            fn(s);
            if (Array.isArray(s.body)) walk(s.body);
            if (Array.isArray(s.steps)) walk(s.steps);
            if (Array.isArray(s.then)) walk(s.then);
            if (Array.isArray(s.else)) walk(s.else);
            if (Array.isArray(s.branches)) {
                for (const b of s.branches) walk(Array.isArray(b) ? b : (Array.isArray(b?.steps) ? b.steps : []));
            }
        }
    };
    walk(definition?.steps);
}

/**
 * @param {Record<string, any> | null | undefined} definition
 * @param {(step: Record<string, any>) => void} fn
 */
function _walkSteps(definition, fn) {
    try {
        const graph = require('../../automation/automationGraph');
        if (typeof graph.walkSteps === 'function') return graph.walkSteps(definition, fn);
    } catch (err) { bestEffort('compliance/detectors/industrialIntegrations:_walkSteps', err); /* not there yet — fall back */ }
    return _fallbackWalkSteps(definition, fn);
}

/**
 * The strings of a step worth scanning: urls, tool names, code, labels, tool lists.
 * @param {Record<string, any>} step
 */
function stepText(step) {
    /** @type {string[]} */
    const parts = [];
    for (const key of ['name', 'label', 'title', 'type', 'url', 'tool', 'integration', 'provider', 'server', 'endpoint', 'host', 'topic', 'broker', 'code', 'source', 'description', 'prompt']) {
        if (typeof step[key] === 'string') parts.push(step[key]);
    }
    if (step.headers && typeof step.headers === 'object') parts.push(_safeString(step.headers));
    if (step.inputs && typeof step.inputs === 'object') parts.push(_safeString(step.inputs));
    if (step.config && typeof step.config === 'object') parts.push(_safeString(step.config));
    if (Array.isArray(step.tools)) parts.push(step.tools.map(t => (typeof t === 'string' ? t : _safeString(t?.name || t?.tool || t))).join(' '));
    return parts.join('\n');
}

/**
 * @param {string | Record<string, any> | null | undefined} definition
 */
function scanAutomationDefinition(definition) {
    const def = typeof definition === 'string' ? (() => { try { return JSON.parse(definition); } catch { return {}; } })() : (definition || {});
    /** @type {string[]} */
    const chunks = [];
    if (typeof def.name === 'string') chunks.push(def.name);
    if (typeof def.description === 'string') chunks.push(def.description);
    if (def.trigger && typeof def.trigger === 'object') chunks.push(stepText(def.trigger));
    _walkSteps(def, (step) => chunks.push(stepText(step)));
    return scanText(chunks.join('\n'));
}

// ── sources ─────────────────────────────────────────────────────────────────

/**
 * @template T
 * @param {string} name
 * @param {{ source: string, reason: string }[]} skipped
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | null>}
 */
async function _source(name, skipped, fn) {
    try {
        return await fn();
    } catch (e) {
        // Class and SQLSTATE only: a driver message can quote row values, and
        // `skipped` enters the evidence chain (lib/errorShape.js).
        skipped.push({ source: name, reason: _isNotProvisioned(e) ? 'not provisioned' : `query failed: ${errorLabel(e)}` });
        return null;
    }
}

/** @typedef {{ source: string; id: string; label: string; signals: { kind: string; value: string; label?: string; }[]; confidence: string; scope?: string; active?: boolean; }} Match */

/**
 * @param {string} orgId
 * @returns {Promise<{ scanned: { custom_integrations: number, automations: number, connections: number, activity_hosts: number, mcp_servers: number }, matches: Match[], skipped: { source: string, reason: string }[], heuristics_version: string }>}
 */
async function detect(orgId) {
    const scanned = { custom_integrations: 0, automations: 0, connections: 0, activity_hosts: 0, mcp_servers: 0 };
    /** @type {Match[]} */
    const matches = [];
    /** @type {{ source: string, reason: string }[]} */
    const skipped = [];

    /**
     * @param {string} source
     * @param {string | number} id
     * @param {string} label
     * @param {{ kind: string; value: string; }[]} signals
     * @param {Record<string, any>} [extra]
     */
    const push = (source, id, label, signals, extra = {}) => {
        if (!signals.length) return;
        matches.push({ source, id: String(id), label: String(label || id), signals, confidence: confidenceOf(signals), ...extra });
    };

    // 1. Custom integrations (REST / remote MCP definitions the org built).
    const customRows = await _source('custom_integrations', skipped, () => db.getAll(`
        SELECT id, name, description, kind, status, definition, activated_definition
        FROM org_custom_integrations
        WHERE org_id = $1
        ORDER BY updated_at DESC
        LIMIT ${ROW_CAP}
    `, [orgId]));
    for (const r of customRows || []) {
        scanned.custom_integrations += 1;
        const text = [r.name, r.description, _safeString(r.definition), _safeString(r.activated_definition)].join('\n');
        push('custom_integration', r.id, r.name, scanText(text), { kind: r.kind || null, status: r.status || null });
    }

    // 2. Automations — walk every step of the definition.
    const automationRows = await _source('automations', skipped, () => db.getAll(`
        SELECT a.id, a.title, a.description, a.definition_json, a.is_active
        FROM automations a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE a.organization_id = $1
           OR (a.organization_id IS NULL AND u."organizationId" = $1)
        ORDER BY a.updated_at DESC
        LIMIT ${ROW_CAP}
    `, [orgId]));
    for (const r of automationRows || []) {
        scanned.automations += 1;
        const signals = scanAutomationDefinition(r.definition_json);
        const meta = scanText([r.title, r.description].join('\n'));
        for (const s of meta) if (!signals.some(x => x.kind === s.kind && x.value === s.value)) signals.push(s);
        push('automation', r.id, r.title, signals, { active: r.is_active === true });
    }

    // 3. Named connections — the provider slug and the label.
    const connectionRows = await _source('connections', skipped, () => db.getAll(`
        SELECT id, provider, label, kind, status
        FROM integration_connections
        WHERE org_id = $1
        ORDER BY updated_at DESC
        LIMIT ${ROW_CAP}
    `, [orgId]));
    for (const r of connectionRows || []) {
        scanned.connections += 1;
        push('connection', r.id, `${r.provider}${r.label ? ` · ${r.label}` : ''}`, scanText([r.provider, r.label].join(' ')), { provider: r.provider || null, status: r.status || null });
    }

    // 4. Where traffic actually went in the last 90 days.
    const activityRows = await _source('activity_log', skipped, () => db.getAll(`
        SELECT COALESCE(dest_host, tls_servername, server_endpoint) AS host,
               MAX(server_endpoint) AS endpoint,
               COUNT(*)::int AS calls
        FROM integration_activity_log
        WHERE organization_id = $1
          AND timestamp >= NOW() - INTERVAL '${ACTIVITY_WINDOW_DAYS} days'
          AND COALESCE(dest_host, tls_servername, server_endpoint) IS NOT NULL
        GROUP BY 1
        ORDER BY calls DESC
        LIMIT ${ROW_CAP}
    `, [orgId]));
    for (const r of activityRows || []) {
        scanned.activity_hosts += 1;
        const signals = scanText([r.host, r.endpoint].filter(Boolean).join('\n'), { keywords: false });
        push('activity_host', r.host, r.host, signals, { calls_90d: Number(r.calls) || 0 });
    }

    // 5. Admin-defined MCP servers (platform-wide table, no org column).
    const mcpRows = await _source('mcp_servers', skipped, () => db.getAll(`
        SELECT id, name, url, command, args, description
        FROM mcp_servers
        ORDER BY name
        LIMIT ${ROW_CAP}
    `));
    for (const r of mcpRows || []) {
        scanned.mcp_servers += 1;
        const text = [r.name, r.description, r.url, r.command, _safeString(r.args)].join('\n');
        push('mcp_server', r.id, r.name, scanText(text), { scope: 'platform' });
    }

    matches.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1) || a.label.localeCompare(b.label));
    return { scanned, matches, skipped, heuristics_version: HEURISTICS_VERSION };
}

module.exports = {
    detect,
    scanText,
    scanAutomationDefinition,
    confidenceOf,
    stepText,
    SCHEMES,
    PORTS,
    KEYWORD_RE,
    VENDOR_HOST_RE,
    HEURISTICS_VERSION,
    ACTIVITY_WINDOW_DAYS,
    _fallbackWalkSteps,
};
