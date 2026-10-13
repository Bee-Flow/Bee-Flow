// @typecheck
/**
 * The two halves of "bridge grants are requires" (see the header of
 * install.js): what an install writes for a page, and what it refuses to
 * write and reports instead. Split out of install.js, which re-exports both.
 */

'use strict';

/**
 * The bridge grants an installed page gets: the ones this install can vouch
 * for, and nothing else. See the module header for why a granted tool is
 * authority over the installer's account rather than a property of the page.
 *
 * `ai` is written EXPLICITLY rather than omitted. Leaving it out would work
 * today — updateBridgeGrants treats an absent key as "keep what is there", and
 * a page created a moment ago carries the store's default — but that makes the
 * safety of an install depend on a default two modules away staying what it is.
 * Written out, the install says what it grants.
 *
 * An automation grant survives only if the file pointed at an automation INSIDE
 * this bundle with `{ $ref }` and that automation actually landed. A bare id is
 * not a reference to anything this bundle contains: it names a row in the
 * installation the file came from, so it is dropped. A `$ref` whose target did
 * not install is dropped too, and NAMED through `unresolved` — the page ends up
 * with one grant fewer, never with a grant it cannot explain.
 */
function safeInstallGrants(entity, refMap, unresolved = []) {
    const { DEFAULT_BRIDGE_GRANTS } = require('../../../stores/webpage/bridgeGrants');
    const asked = (entity && typeof entity.bridgeGrants === 'object' && entity.bridgeGrants) || {};

    const automations = [];
    for (const grant of (Array.isArray(asked.automations) ? asked.automations : [])) {
        const pointer = grant && grant.automationId;
        const ref = (pointer && typeof pointer === 'object' && typeof pointer.$ref === 'string')
            ? pointer.$ref : null;
        if (!ref) continue;                       // a bare id names another installation's row
        const real = refMap.get(ref);
        if (typeof real !== 'string') { unresolved.push(ref); continue; }
        automations.push({
            automationId: real,
            ...(grant.label ? { label: String(grant.label) } : {}),
        });
    }

    // Table grants (F14): the same rule as automations. Only a table this bundle
    // carries, by `$ref`, resolved to the copy this install made. Mode and
    // columns travel; PUBLIC columns do not: anonymous read access to the
    // installer's table is the table-shaped twin of public AI, and an install
    // never switches that on for anybody.
    const tables = [];
    for (const grant of (Array.isArray(asked.tables) ? asked.tables : [])) {
        const pointer = grant && grant.datatableId;
        const ref = (pointer && typeof pointer === 'object' && typeof pointer.$ref === 'string') ? pointer.$ref : null;
        if (!ref) continue;                       // a bare id or a hole names nothing in this bundle
        const real = refMap.get(ref);
        if (typeof real !== 'string') { unresolved.push(ref); continue; }
        tables.push({
            datatableId: real,
            mode: grant.mode === 'readwrite' ? 'readwrite' : 'read',
            columns: Array.isArray(grant.columns) ? grant.columns.filter(c => typeof c === 'string') : [],
            publicColumns: [],
        });
    }

    // The page's agent: one in this bundle, by `$ref`, or none.
    let agent = null;
    const ap = asked.agent && asked.agent.agentId;
    if (ap && typeof ap === 'object' && typeof ap.$ref === 'string') {
        const real = refMap.get(ap.$ref);
        if (typeof real === 'string') agent = { agentId: real };
        else unresolved.push(ap.$ref);
    }

    return {
        ai: { ...DEFAULT_BRIDGE_GRANTS.ai },
        automations,
        // A tool name IS the grant: the bridge runs as the page's author, so
        // carrying one over would hand the installer's Gmail to a file.
        integrations: [],
        tables,
        agent,
    };
}

/**
 * What a Blueprint ASKED a page to be allowed to do, that an install refuses to
 * grant — as rows somebody can act on.
 *
 * This is the other half of `safeInstallGrants`: dropping a request silently
 * would turn "we do not grant this for you" into "this Solution is broken and
 * nobody said why". The install wizard lists these in its Connect step and the
 * installer re-assigns them by hand, with the connection status in front of
 * them; the post-install report carries the same rows for a file install.
 *
 * Run over the RAW manifest, never the checked copy: sanitizeManifest strips
 * every `ai.public*` key before install sees it, and showing what was stripped
 * is the entire point.
 *
 * `publicSpendCapUsd` travels on the row because a request to enable anonymous
 * AI is not the same size at $2 and at $50, and the person deciding should see
 * which one they were asked for.
 */
function collectGrantRequires(manifest) {
    const entities = manifest?.solution?.entities || {};
    const declared = new Set();
    for (const list of Object.values(entities)) {
        for (const e of (Array.isArray(list) ? list : [])) {
            if (e && typeof e.ref === 'string') declared.add(e.ref);
        }
    }

    const rows = [];
    for (const entity of (Array.isArray(entities.webpages) ? entities.webpages : [])) {
        const asked = (entity && typeof entity.bridgeGrants === 'object' && entity.bridgeGrants) || {};
        const on = { ref: entity?.ref || null, name: entity?.name || '' };

        for (const grant of (Array.isArray(asked.integrations) ? asked.integrations : [])) {
            if (grant && typeof grant.tool === 'string' && grant.tool) {
                // fixedArgs deliberately NOT echoed: sanitizeManifest removes
                // them because they can carry a path, an id or a token, and a
                // row that displayed them would put them back on a screen.
                rows.push({ ...on, kind: 'integration', tool: grant.tool, ...(grant.label ? { label: String(grant.label) } : {}) });
            }
        }

        for (const grant of (Array.isArray(asked.automations) ? asked.automations : [])) {
            const pointer = grant && grant.automationId;
            const ref = (pointer && typeof pointer === 'object' && typeof pointer.$ref === 'string') ? pointer.$ref : null;
            // In-bundle refs are the one thing install DOES carry, so they are
            // not a require. Everything else is: a bare id, or a ref the file
            // does not contain.
            if (ref && declared.has(ref)) continue;
            rows.push({
                ...on, kind: 'automation',
                ...(ref ? { ref$: ref } : {}),
                ...(typeof pointer === 'string' ? { automationId: pointer } : {}),
                ...(grant?.label ? { label: String(grant.label) } : {}),
            });
        }

        // Any `public*` flag the file switched ON. Matched by SHAPE, like
        // manifest.stripNeverInstallable — a `publicSomethingNew` added to
        // bridgeGrants next year is reported by the rule written before it
        // existed. A cap or a tier alone opens no door, so it is carried on the
        // row rather than being a row of its own.
        const ai = (asked.ai && typeof asked.ai === 'object') ? asked.ai : null;
        if (ai && Object.entries(ai).some(([k, v]) => /^public/.test(k) && v === true)) {
            const flags = {};
            for (const [k, v] of Object.entries(ai)) if (/^public/.test(k)) flags[k] = v;
            rows.push({ ...on, kind: 'public_ai', flags });
        }
    }
    return rows;
}

module.exports = { safeInstallGrants, collectGrantRequires };
