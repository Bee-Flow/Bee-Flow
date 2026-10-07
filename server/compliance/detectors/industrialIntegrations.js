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

const HEURISTICS_VERSION = '1.0.0';
const ACTIVITY_WINDOW_DAYS = 90;
const ROW_CAP = 500;
const MAX_TEXT = 200_000;

const SCHEMES = {
    'opc.tcp': { label: 'OPC UA', confidence: 'high' },
    'opc.https': { label: 'OPC UA', confidence: 'high' },
    'opc.wss': { label: 'OPC UA', confidence: 'high' },
    mqtt: { label: 'MQTT', confidence: 'low' },
    mqtts: { label: 'MQTT', confidence: 'low' },
    ws_mqtt: { label: 'MQTT', confidence: 'low' },
    modbus: { label: 'Modbus', confidence: 'high' },
    'modbus-tcp': { label: 'Modbus', confidence: 'high' },
    s7: { label: 'Siemens S7', confidence: 'high' },
    ads: { label: 'Beckhoff ADS', confidence: 'high' },
    coap: { label: 'CoAP', confidence: 'high' },
    coaps: { label: 'CoAP', confidence: 'high' },
    'ethernet-ip': { label: 'EtherNet/IP', confidence: 'high' },
    enip: { label: 'EtherNet/IP', confidence: 'high' },
    bacnet: { label: 'BACnet', confidence: 'high' },
    dnp3: { label: 'DNP3', confidence: 'high' },
    iec104: { label: 'IEC 60870-5-104', confidence: 'high' },
    'iec-104': { label: 'IEC 60870-5-104', confidence: 'high' },
    profinet: { label: 'PROFINET', confidence: 'high' },
};

const PORTS = {
    502: { label: 'Modbus/TCP', confidence: 'high' },
    4840: { label: 'OPC UA', confidence: 'high' },
    4843: { label: 'OPC UA (TLS)', confidence: 'high' },
    1883: { label: 'MQTT', confidence: 'low' },
    8883: { label: 'MQTT (TLS)', confidence: 'low' },
    102: { label: 'Siemens S7 / ISO-TSAP', confidence: 'high' },
    44818: { label: 'EtherNet/IP', confidence: 'high' },
    // Low, not high: 2222 is also the most common alternative SSH/SFTP port,
    // and a backup job on sftp://host:2222 is not a PLC. On its own it only
    // hints; with an EtherNet/IP keyword or the 44818 port it is high.
    2222: { label: 'EtherNet/IP (implicit)', confidence: 'low' },
    20000: { label: 'DNP3', confidence: 'high' },
    47808: { label: 'BACnet', confidence: 'high' },
    48898: { label: 'Beckhoff ADS', confidence: 'high' },
    2404: { label: 'IEC 60870-5-104', confidence: 'high' },
    34962: { label: 'PROFINET RT', confidence: 'high' },
    34963: { label: 'PROFINET RT', confidence: 'high' },
    34964: { label: 'PROFINET RT', confidence: 'high' },
};

// Schemes whose port is never an industrial-protocol port, whatever its number.
const NON_INDUSTRIAL_SCHEMES = new Set(['ssh', 'sftp', 'scp', 'ftp', 'ftps', 'git', 'rsync', 'smtp', 'smtps', 'imap', 'imaps']);

const VENDOR_HOST_RE = /(?:^|\.)(?:mindsphere\.io|insights-hub\.[a-z.]+|thingworx\.[a-z.]+|ignitionautomation\.[a-z.]+|ptc\.io|kepware\.com|inductiveautomation\.com|thingsboard\.cloud|thingsboard\.io)$/i;

// Vocabulary over names/descriptions/tool names. Whole-word-ish; case-insensitive.
const KEYWORD_RE = /\b(opc[- ]?ua\w*|modbus\w*|mqtt\w*|scada|plc|s7-?\d{3,4}|siemens|beckhoff|twincat|codesys|rockwell|allen[- ]bradley|schneider(?:[- ]electric)?|wago|ignition|kepware|profinet|ethernet\/ip|bacnet|dnp3|iec[- ]?6185\d?|iec[- ]?104|node-?red|thingsboard|mindsphere|insights ?hub|thingworx|robot(?:ic)?s?|machine control|safety plc|fieldbus|profibus|canopen|ethercat|hmi)\b/gi;

// Anything that looks like <scheme>://<rest> — also inside JSON strings.
const URL_RE = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s"'<>\\)\]}]+)/gi;
// Bare host:port outside a URL (IPv4 or hostname). The port must end at a word boundary.
const HOSTPORT_RE = /(?:^|[\s"'=(\[{,])((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.?):(\d{2,5})(?![\d.])/gi;

function _isNotProvisioned(e) {
    return !!e && (e.code === '42703' || e.code === '42P01');
}

function _stripUserinfo(hostPart) {
    // user:pass@host:port/path → host:port/path
    const at = hostPart.indexOf('@');
    const slash = hostPart.indexOf('/');
    if (at >= 0 && (slash < 0 || at < slash)) return hostPart.slice(at + 1);
    return hostPart;
}

function _hostAndPort(rest) {
    const authority = _stripUserinfo(rest).split(/[/?#]/)[0];
    const m = authority.match(/^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
    if (!m) return { host: authority.toLowerCase(), port: null };
    return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : null };
}

// Protocol names show up as identifier prefixes in code (ModbusRTU,
// mqttClient, OpcUaSession); the keyword regex allows the suffix and this
// folds the match back to the protocol name for the evidence row.
const KEYWORD_PREFIXES = ['opc-ua', 'opc ua', 'opcua', 'modbus', 'mqtt'];
function _canonicalKeyword(raw) {
    const v = String(raw).toLowerCase();
    for (const base of KEYWORD_PREFIXES) if (v.startsWith(base)) return base.replace(/[- ]/, '-');
    return v;
}

function _safeString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Scan free text (names, descriptions, stringified definitions) for the
 * signals above. Returns deduplicated signals.
 *
 * @param {string} text
 * @param {{ keywords?: boolean }} [opts]  keywords default true
 */
function scanText(text, opts = {}) {
    const src = _safeString(text).slice(0, MAX_TEXT);
    const signals = [];
    const seen = new Set();
    const add = (kind, value) => {
        const key = `${kind}:${value}`;
        if (seen.has(key)) return;
        seen.add(key);
        signals.push({ kind, value });
    };

    // URLs: scheme + port + vendor host.
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
 */
function _fallbackWalkSteps(definition, fn) {
    const seen = new Set();
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

function _walkSteps(definition, fn) {
    try {
        const graph = require('../../automation/automationGraph');
        if (typeof graph.walkSteps === 'function') return graph.walkSteps(definition, fn);
    } catch { /* not there yet — fall back */ }
    return _fallbackWalkSteps(definition, fn);
}

/** The strings of a step worth scanning: urls, tool names, code, labels, tool lists. */
function stepText(step) {
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

function scanAutomationDefinition(definition) {
    const def = typeof definition === 'string' ? (() => { try { return JSON.parse(definition); } catch { return {}; } })() : (definition || {});
    const chunks = [];
    if (typeof def.name === 'string') chunks.push(def.name);
    if (typeof def.description === 'string') chunks.push(def.description);
    if (def.trigger && typeof def.trigger === 'object') chunks.push(stepText(def.trigger));
    _walkSteps(def, (step) => chunks.push(stepText(step)));
    return scanText(chunks.join('\n'));
}

// ── sources ─────────────────────────────────────────────────────────────────

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

/**
 * @param {string} orgId
 * @returns {Promise<{ scanned: object, matches: object[], skipped: object[], heuristics_version: string }>}
 */
async function detect(orgId) {
    const scanned = { custom_integrations: 0, automations: 0, connections: 0, activity_hosts: 0, mcp_servers: 0 };
    const matches = [];
    const skipped = [];

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
