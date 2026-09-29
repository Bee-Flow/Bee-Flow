/**
 * App Studio canonicalizer — the style block on a node or a section.
 */

'use strict';

const { HEX_RE, STYLE_KNOBS, unitSpan } = require('../componentSpecs');
const { isObject } = require('./shared');

// ---------------------------------------------------------------------------
// Style — clamp/coerce numeric knobs, default invalid enums, drop unknown keys.
// ---------------------------------------------------------------------------

function cleanStyle(raw, allowedKeys, defaults, path, push, { recordMissing = false, missingCode = 'section.style_defaulted', rejectPctHeight = false } = {}) {
    const out = { ...defaults };
    if (raw === undefined || raw === null) {
        if (recordMissing) push(missingCode, path, 'Missing style — filled with defaults.');
        return out;
    }
    if (!isObject(raw)) {
        push('style.invalid', path, 'style must be an object — reset to defaults.');
        return out;
    }
    // The advanced sizing pairs read their UNIT off a sibling key (widthValue
    // is measured in whatever widthMode says), and Object.entries order is
    // whatever the author's JSON happened to be — so resolve the modes up
    // front. Key order can then never change how a value is clamped.
    const effectiveMode = (modeKnob) => {
        const spec = STYLE_KNOBS[modeKnob];
        const v = raw[modeKnob];
        return spec.values.includes(v) ? v : spec.default;
    };

    const unknown = [];
    for (const [k, v] of Object.entries(raw)) {
        if (!allowedKeys.includes(k)) { unknown.push(k); continue; }
        const knob = STYLE_KNOBS[k];
        if (knob.type === 'unitInt') {
            // null/undefined is the legitimate "not set" state — the inspector
            // commits it when the author switches back to columns/preset.
            // Dropping it (rather than defaulting) is what keeps a definition
            // that never used advanced sizing byte-identical after a round trip.
            if (v === null || v === undefined) continue;
            const mode = effectiveMode(knob.modeKnob);
            const range = knob.units[mode];
            let num = v;
            if (typeof num === 'string' && num.trim() !== '' && Number.isFinite(Number(num))) num = Number(num);
            if (typeof num !== 'number' || !Number.isFinite(num)) {
                push('style.invalid', `${path}.${k}`, `${k} must be a number — dropped (${knob.modeKnob} is ${JSON.stringify(mode)}).`);
                continue;
            }
            // No range means this mode carries no value at all ('span' /
            // 'preset'). Keep what the author wrote rather than deleting it —
            // validate.js is the one that says it does nothing — but clamp it
            // to the widest legal window so garbage can never persist.
            const bounds = range || unitSpan(k);
            const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(num)));
            if (clamped !== v) push('style.clamped', `${path}.${k}`, `${k}: ${JSON.stringify(v)} coerced/clamped to ${clamped} (range ${bounds.min}..${bounds.max}).`);
            if (!range) {
                push('style.inert_unit', `${path}.${k}`, `${k} is ignored while ${knob.modeKnob} is ${JSON.stringify(mode)} — set ${knob.modeKnob} to ${Object.keys(knob.units).join(' or ')} to use it.`);
            }
            out[k] = clamped;
        } else if (knob.type === 'int') {
            let num = v;
            if (typeof num === 'string' && num.trim() !== '' && Number.isFinite(Number(num))) num = Number(num);
            if (typeof num !== 'number' || !Number.isFinite(num)) {
                push('style.invalid', `${path}.${k}`, `${k} must be an integer ${knob.min}..${knob.max} — reset to ${JSON.stringify(knob.default)}.`);
                out[k] = knob.default;
                continue;
            }
            const clamped = Math.min(knob.max, Math.max(knob.min, Math.round(num)));
            if (clamped !== v) push('style.clamped', `${path}.${k}`, `${k}: ${JSON.stringify(v)} coerced/clamped to ${clamped} (range ${knob.min}..${knob.max}).`);
            out[k] = clamped;
        } else if (knob.type === 'enum') {
            if (knob.values.includes(v)) { out[k] = v; continue; }
            push('style.invalid', `${path}.${k}`, `${k}: unknown value ${JSON.stringify(v)} — reset to ${JSON.stringify(knob.default)}. Legal: ${knob.values.map((x) => JSON.stringify(x)).join(', ')}.`);
            out[k] = knob.default;
        } else if (knob.type === 'colorOrRole') {
            if (v === null || (typeof v === 'string' && (knob.roles.includes(v) || HEX_RE.test(v)))) { out[k] = v; continue; }
            push('style.invalid', `${path}.${k}`, `${k}: ${JSON.stringify(v)} is neither a role (${knob.roles.join(', ')}) nor #rrggbb — reset to ${JSON.stringify(knob.default)}.`);
            out[k] = knob.default;
        }
    }
    if (unknown.length) {
        push('style.unknown_key', path, `Dropped unknown style keys: ${unknown.join(', ')}. Legal keys: ${allowedKeys.join(', ')}.`);
    }
    // A section is a flex item in the screen's auto-height stack, so there is
    // never a definite height for a percentage to measure — `height: 50%` on a
    // section is not "half the page", it is nothing at all. Repaired here so
    // the stored definition cannot carry a knob that does nothing; validate.js
    // says the same thing to whoever wrote it.
    if (rejectPctHeight && out.heightMode === 'pct') {
        push('style.invalid', `${path}.heightMode`, 'A section has no parent height to be a percentage of — reset to "preset". Use "vh" for a share of the viewport, or "px".');
        out.heightMode = STYLE_KNOBS.heightMode.default;
        // …and take the number with it. Everywhere else this file KEEPS a value
        // whose mode carries no unit (the author chose that mode, and validate
        // tells them it is inert). Here the author did NOT choose 'preset' — we
        // did, one line up — so leaving the number behind hands them a
        // `style.unit_without_mode` error blaming them for a mode they never
        // set, on a definition canonicalize itself produced. The repair above
        // already names the fix; finish it rather than half-repairing.
        delete out.heightValue;
    }
    return out;
}

module.exports = { cleanStyle };
