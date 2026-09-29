/**
 * App Studio builder tools — what "the SAME batch" and "the same entry" mean,
 * so a resent app_add_components call does not mint a second copy of what
 * already landed.
 *
 * Three answers, narrowest first: an entry's signature (its content without
 * the per-call tempId handles), a container's SHELL signature (everything but
 * its children — the corrected resend of a card whose one child failed), and
 * the looser form-name clash (a form name is unique per screen by contract).
 */

'use strict';

const ops = require('../../definitionOps');
const { canonicalJson } = require('../../../automation/builderTools/suggestedPatch');

/**
 * Forms in the batch whose props.name a form on the target screen already
 * carries → [{ name, id }] of the EXISTING forms, or null. The screen is the
 * parent section's, or the screen of the parent container.
 */
function formNameClash(def, parentId, list) {
    const sec = ops.findSection(def, parentId);
    const screen = sec ? sec.screen : (ops.findNode(def, parentId) || {}).screen;
    if (!screen) return null;
    const wanted = new Set();
    const collect = (entries, depth = 0) => {
        if (!Array.isArray(entries) || depth > 6) return;
        for (const e of entries) {
            if (!e || typeof e !== 'object') continue;
            if (e.type === 'form' && e.props && typeof e.props.name === 'string' && e.props.name.trim()) wanted.add(e.props.name.trim());
            collect(e.children, depth + 1);
        }
    };
    collect(list);
    if (!wanted.size) return null;
    const existing = [];
    const walk = (nodes) => {
        for (const n of Array.isArray(nodes) ? nodes : []) {
            if (!n || typeof n !== 'object') continue;
            if (n.type === 'form' && n.props && wanted.has(String(n.props.name || '').trim())) existing.push({ name: n.props.name.trim(), id: n.id });
            walk(n.children);
        }
    };
    for (const section of screen.sections || []) walk(section.children);
    return existing.length ? existing : null;
}

/** The batch without its per-call handles — what "the same batch" means. */
function stripTempIds(list) {
    const strip = (entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const { tempId, ...rest } = entry;
        void tempId;
        if (Array.isArray(rest.children)) rest.children = rest.children.map(strip);
        return rest;
    };
    return Array.isArray(list) ? list.map(strip) : list;
}

/**
 * One entry's identity across calls — its content without the per-call
 * handles — and, for a container, the identity of its SHELL (everything but
 * its children). A batch that landed in part is resent with the failed
 * entry corrected far more often than as the identical bytes (the recorded
 * dashboard traces, and two years of "nothing was applied — resend" having
 * trained exactly that), so the record of a partial batch keeps these per
 * node: an entry that matches one already built is skipped, and a container
 * whose shell matches gets only its NEW children (see landedTwin below).
 */
function entrySig(entry) {
    return canonicalJson(stripTempIds([entry])[0]);
}
function shellSig(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const { children, ...rest } = entry;
    void children;
    return entrySig(rest);
}

module.exports = {
    formNameClash,
    stripTempIds,
    entrySig,
    shellSig,
};
