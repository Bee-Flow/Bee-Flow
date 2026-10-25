// @typecheck strict
const { isMissingTable } = require('../../utils/isMissingTable');

const HEURISTICS_VERSION = '1.0.0';

const ACTIVITY_WINDOW_DAYS = 90;

const ROW_CAP = 500;

const MAX_TEXT = 200_000;

/** @type {Record<string, { label: string; confidence: string; }>} */
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

/** @type {Record<string, { label: string; confidence: string; }>} */
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

/** @param {{ code?: string } | null | undefined} e */
function _isNotProvisioned(e) {
    return isMissingTable(e);
}

/**
 * @param {string} hostPart
 */
function _stripUserinfo(hostPart) {
    // user:pass@host:port/path → host:port/path
    const at = hostPart.indexOf('@');
    const slash = hostPart.indexOf('/');
    if (at >= 0 && (slash < 0 || at < slash)) return hostPart.slice(at + 1);
    return hostPart;
}

/**
 * @param {string} rest
 */
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

/**
 * @param {string} raw
 */
function _canonicalKeyword(raw) {
    const v = String(raw).toLowerCase();
    for (const base of KEYWORD_PREFIXES) if (v.startsWith(base)) return base.replace(/[- ]/, '-');
    return v;
}

/**
 * @param {string} value
 */
function _safeString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

module.exports = { HEURISTICS_VERSION, ACTIVITY_WINDOW_DAYS, ROW_CAP, MAX_TEXT, SCHEMES, PORTS, NON_INDUSTRIAL_SCHEMES, VENDOR_HOST_RE, KEYWORD_RE, URL_RE, HOSTPORT_RE, _isNotProvisioned, _hostAndPort, _canonicalKeyword, _safeString };
