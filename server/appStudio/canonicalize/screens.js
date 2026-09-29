/**
 * App Studio canonicalizer — screens and their sections.
 */

'use strict';

const {
    SCREEN_SPEC,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
    expandStyleKnobs,
} = require('../componentSpecs');
const { isObject, truncate } = require('./shared');
const { cleanStyle } = require('./style');
const { canonNode, cleanRoleRefs } = require('./nodes');

// ---------------------------------------------------------------------------
// Screens & sections
// ---------------------------------------------------------------------------

function canonScreen(screen, path, ids, push) {
    const id = ids.canonId(screen.id, 'screen', `${path}.id`);
    const out = { id };

    // name
    if (typeof screen.name === 'string' && screen.name) {
        out.name = truncate(screen.name, SCREEN_SPEC.name.maxLen, `${path}.name`, push);
    } else {
        out.name = SCREEN_SPEC.name.default;
        if (screen.name !== undefined) push('screen.field_invalid', `${path}.name`, `Screen name must be a non-empty string — defaulted to "${SCREEN_SPEC.name.default}".`);
    }
    // icon
    if (screen.icon === undefined || screen.icon === null || typeof screen.icon === 'string') {
        out.icon = screen.icon === undefined ? SCREEN_SPEC.icon.default : screen.icon;
    } else {
        out.icon = SCREEN_SPEC.icon.default;
        push('screen.field_invalid', `${path}.icon`, 'Screen icon must be a string or null — defaulted.');
    }
    // showInNav
    if (typeof screen.showInNav === 'boolean') out.showInNav = screen.showInNav;
    else {
        out.showInNav = SCREEN_SPEC.showInNav.default;
        if (screen.showInNav !== undefined) push('screen.field_invalid', `${path}.showInNav`, 'showInNav must be a boolean — defaulted to true.');
    }
    // maxWidth
    if (SCREEN_SPEC.maxWidth.values.includes(screen.maxWidth)) out.maxWidth = screen.maxWidth;
    else {
        out.maxWidth = SCREEN_SPEC.maxWidth.default;
        if (screen.maxWidth !== undefined) push('screen.field_invalid', `${path}.maxWidth`, `maxWidth must be one of ${SCREEN_SPEC.maxWidth.values.join(', ')} — defaulted to "${SCREEN_SPEC.maxWidth.default}".`);
    }

    // refreshInterval — omitted when off, so a screen that never asked for
    // polling canonicalizes byte-identically to before.
    if (screen.refreshInterval !== undefined && screen.refreshInterval !== null) {
        if (SCREEN_SPEC.refreshInterval.values.includes(screen.refreshInterval)) {
            if (screen.refreshInterval) out.refreshInterval = screen.refreshInterval;
        } else {
            push('screen.field_invalid', `${path}.refreshInterval`,
                `refreshInterval must be one of ${SCREEN_SPEC.refreshInterval.values.join(', ')} seconds — defaulted to off.`);
        }
    }

    // v2 optional fields — only emitted when present, so v1 screens are unchanged.
    if (screen.kind !== undefined && screen.kind !== null) {
        if (SCREEN_SPEC.kind.values.includes(screen.kind)) out.kind = screen.kind;
        else push('screen.field_invalid', `${path}.kind`, `screen.kind must be one of ${SCREEN_SPEC.kind.values.filter((v) => v).join(', ')} — dropped.`);
    }
    if (screen.visibleToRoles !== undefined) {
        const cleaned = cleanRoleRefs(screen.visibleToRoles, `${path}.visibleToRoles`, push);
        if (cleaned !== undefined) out.visibleToRoles = cleaned;
    }
    // v3 optional: emitted only when it says something, so a screen without a
    // description canonicalizes byte-identically to before.
    if (screen.description !== undefined && screen.description !== null) {
        if (typeof screen.description === 'string') {
            const text = screen.description.trim();
            if (text) out.description = truncate(text, SCREEN_SPEC.description.maxLen, `${path}.description`, push);
        } else {
            push('screen.field_invalid', `${path}.description`, 'Screen description must be a string or null — dropped.');
        }
    }

    // sections
    out.sections = [];
    let rawSections = screen.sections;
    if (!Array.isArray(rawSections)) {
        if (rawSections !== undefined) push('screen.sections_invalid', `${path}.sections`, 'sections must be an array — reset to [].');
        rawSections = [];
    }
    rawSections.forEach((section, i) => {
        const sp = `${path}.sections[${i}]`;
        if (!isObject(section)) {
            push('section.invalid', sp, 'Section is not an object — dropped.');
            return;
        }
        const sid = ids.canonId(section.id, 'section', `${sp}.id`);
        const style = cleanStyle(section.style, expandStyleKnobs(SECTION_STYLE_KNOBS), SECTION_STYLE_DEFAULTS, `${sp}.style`, push, { recordMissing: true, rejectPctHeight: true });
        const children = [];
        let rawChildren = section.children;
        if (!Array.isArray(rawChildren)) {
            if (rawChildren !== undefined && rawChildren !== null) push('section.children_invalid', `${sp}.children`, 'Section children must be an array — reset to [].');
            rawChildren = [];
        }
        rawChildren.forEach((child, ci) => {
            if (!isObject(child)) {
                push('node.invalid', `${sp}.children[${ci}]`, 'Node is not an object — dropped.');
                return;
            }
            children.push(...canonNode(child, `${sp}.children[${ci}]`, 2, ids, push));
        });
        out.sections.push({ id: sid, style, children });
    });

    return out;
}

module.exports = { canonScreen };
