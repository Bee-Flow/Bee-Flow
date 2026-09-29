/**
 * Per-module in-memory log ring — the backing store for the admin "module
 * logs" dialog. hostApi.makeLogger writes through here (debug lines are
 * buffered even when MODULE_DEBUG console output is off) and packageLoader
 * appends lifecycle events as level 'system'.
 *
 * Bounded on every axis: RING_MAX entries per module, MODULES_MAX modules
 * (LRU eviction), MSG_MAX chars per line. In-memory only by design — logs are
 * a per-replica diagnostic, not durable audit (that's moduleAudit.js).
 */

'use strict';

const RING_MAX = 500;
const MODULES_MAX = 50;
const MSG_MAX = 2000;

// moduleId → { entries: [{ts, level, msg}], seq }
// Map iteration order doubles as LRU order (delete+set on touch).
const _buffers = new Map();

function _fmt(args) {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ').slice(0, MSG_MAX);
}

function _touch(moduleId) {
    let buf = _buffers.get(moduleId);
    if (buf) {
        _buffers.delete(moduleId); // re-insert = most recently used
    } else {
        buf = { entries: [], seq: 0 };
        if (_buffers.size >= MODULES_MAX) {
            const oldest = _buffers.keys().next().value;
            _buffers.delete(oldest);
        }
    }
    _buffers.set(moduleId, buf);
    return buf;
}

/** @param {'info'|'warn'|'error'|'debug'|'system'} level */
function append(moduleId, level, args) {
    const buf = _touch(moduleId);
    buf.entries.push({
        ts: new Date().toISOString(),
        seq: ++buf.seq,
        level,
        msg: _fmt(Array.isArray(args) ? args : [args]),
    });
    if (buf.entries.length > RING_MAX) buf.entries.splice(0, buf.entries.length - RING_MAX);
}

/**
 * Newest-last slice of a module's log ring.
 * @param {string} moduleId
 * @param {{limit?:number, level?:string}} opts
 */
function get(moduleId, { limit = 200, level = null } = {}) {
    const buf = _buffers.get(moduleId);
    if (!buf) return [];
    let entries = buf.entries;
    if (level) entries = entries.filter(e => e.level === level);
    const n = Math.max(1, Math.min(RING_MAX, Number(limit) || 200));
    return entries.slice(-n);
}

function clear(moduleId) {
    if (moduleId) _buffers.delete(moduleId);
    else _buffers.clear();
}

module.exports = { append, get, clear, RING_MAX, MODULES_MAX, MSG_MAX };
