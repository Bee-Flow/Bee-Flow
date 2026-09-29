/**
 * App Studio builder — the CORE (small-band) projection of the tool schemas.
 *
 * TOOL_SCHEMAS (./schemas.js) is one surface for every model. The core menu
 * — Gemma-class models on llama.cpp, Haiku, the mini tiers — reads the same
 * tools with the knobs a small model never turns pruned away, and with the
 * two batch tools it drifts on narrowed to the shape that lands. Measured
 * 2026-09-17 on the demo box (Gemma 4 26B-A4B): the 17 core tools were
 * 28.5k chars ≈ 7.5k tokens of every round's prefix; this projection is
 * ~19k. Byte-stable (the prune table is data, the input is a module
 * constant, the result is cached per input), pure (the full schemas are
 * never mutated — mcpBuilder and the cloud bands ship them), and LOCKSTEP:
 * every property path that survives here exists in the full schema
 * (schemasCore.test.js walks both), so a field can only be REMOVED from the
 * small band, never invented for it.
 *
 * What the table may say per tool:
 *   description        — replaces the tool description (shorter, same rules)
 *   keep: [...]        — top-level parameters to keep (everything else dropped)
 *   drop: [...]        — top-level parameters to drop
 *   at: { '<path>': { keep|drop|description } } — the same on a nested
 *                        object (`fields.items`, `components.items`, …)
 *   batchOnly: { key } — keep ONLY the batch parameter and make it required
 *                        (app_update_component: the single form is the one a
 *                        small model mixes with the batch — readBatchArg still
 *                        tolerates a stray single form at run time)
 */

'use strict';

const { MAX_BATCH_PATCHES_PER_CALL } = require('./schemas');

const CORE_PRUNE = {
    app_set_theme: {
        keep: ['preset', 'primary', 'accent', 'appearance', 'navStyle', 'radius', 'density', 'font'],
        // applySetTheme still accepts every knob the full schema declares —
        // a model that has learnt `surface` from a hint may still send it.
    },
    app_add_screen: {
        drop: ['maxWidth', 'refreshInterval', 'visibleToRoles'],
    },
    app_add_components: {
        description: 'Add components under `parentId` (a section sec_… or a container cmp_…). ONE readable group per call: a card with its children, one row of tiles, or a short flat run. Containers (card/form) take nested `children` in this same entry shape. Give an entry a `tempId` to read its real id from the result\'s `ids` map (the form you will wire). Entries belong in components[] only; never resend a batch that already landed (its ids are in the result).',
        at: {
            'components.items': { drop: ['enabledWhen', 'readOnly', 'visibleToRoles', 'validations'] },
            // The full hint teaches the exact-sizing knobs the core prompt forbids.
            'components.items.style': { description: 'Style knobs from this type\'s catalog line (span 1-12 first).' },
        },
    },
    app_update_component: {
        description: `Edit existing components IN PLACE: props/style are shallow-merged (only the keys you pass change), ids and wiring stay. \`updates\`: up to ${MAX_BATCH_PATCHES_PER_CALL} patches {id, props?, style?, visible?, visibleWhen?, computed?} in ONE call; a bad patch is reported at its index in \`failed\` and the others land. Never remove + re-add a component to tweak it.`,
        batchOnly: { key: 'updates' },
        at: {
            'updates.items': { keep: ['id', 'props', 'style', 'visible', 'visibleWhen', 'computed'] },
            'updates.items.style': { description: 'Style patch (merged into the existing style).' },
        },
    },
    app_set_action: {
        description: `Create or update an action: omit \`actionId\` to create (the result returns the new act_… id), pass an existing id to update in place. Wire it onto a button/form with app_bind_action. Batch: \`actions\` — up to ${MAX_BATCH_PATCHES_PER_CALL} { action } entries; read each real id from the result's actions[].index pairing (a failed entry is reported at its index in \`failed\`).`,
        at: {
            actions: { description: `Up to ${MAX_BATCH_PATCHES_PER_CALL} { actionId?, action } entries applied in order. Pass this OR \`action\`, never both.` },
        },
    },
    app_bind_action: {
        description: `Wire a component event to an action: a button's onClick, a form's onSubmit, a data_grid's onRowClick/onRowSelect, a kanban's onCardMove, a select/checkbox/date's onChange. The action must exist (app_set_action first); actionId null unwires. Batch: \`bindings\` — up to ${MAX_BATCH_PATCHES_PER_CALL} {nodeId, event, actionId} entries in one call; a bad entry is reported at its index in \`failed\`, the others land.`,
    },
    app_link_datatable: {
        description: 'Link an EXISTING Studio table (a Nextcloud Tables mirror, any organisation table) into this app by name, key or id. Its rows stay where they are and the app reads them LIVE; the result carries the tbl_ id and the exact field keys to bind ("Excl. btw" is excl_btw). Prefer this over app_upsert_table when the ask names a table that already exists. Never seed a linked table. Calling it again for the same table refreshes its field copy.',
    },
    app_upsert_table: {
        description: 'Create or evolve ONE table in the app\'s OWN database (a table that already exists in Studio is linked with app_link_datatable instead). Omit `tableId` to create; pass an existing tbl_… id to evolve. `fields` is the COMPLETE field list — fields you leave out are dropped. Returns the real tbl_ id and field keys to bind and seed with. A field\'s type never converts in place; a required field added to a populated table needs a `default`.',
        at: {
            'fields.items': { drop: ['fieldId', 'computed'] },
            access: { keep: ['default'], description: 'Row access. default "app": everyone with the app reads/writes (use it for demo/shared data — seeded rows are invisible to members under "owner"); "owner": each user sees only their own rows.' },
        },
    },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The schema node at a dotted path of property names, `items` allowed as a segment. */
function nodeAt(schema, path) {
    let cur = schema;
    for (const seg of path.split('.')) {
        if (!isObject(cur)) return null;
        if (seg === 'items') { cur = cur.items; continue; }
        cur = isObject(cur.properties) ? cur.properties[seg] : undefined;
    }
    return isObject(cur) ? cur : null;
}

function applyKeepDrop(node, rule, where) {
    if (!isObject(node)) throw new Error(`schemasCore: ${where} is not a schema node`);
    if ((rule.keep || rule.drop) && !isObject(node.properties)) {
        throw new Error(`schemasCore: ${where} has no properties to prune`);
    }
    if (Array.isArray(rule.keep)) {
        for (const k of rule.keep) if (!(k in node.properties)) throw new Error(`schemasCore: ${where}.${k} is not in the full schema`);
        for (const k of Object.keys(node.properties)) if (!rule.keep.includes(k)) delete node.properties[k];
        if (Array.isArray(node.required)) node.required = node.required.filter((k) => rule.keep.includes(k));
    }
    if (Array.isArray(rule.drop)) {
        for (const k of rule.drop) {
            if (!(k in node.properties)) throw new Error(`schemasCore: ${where}.${k} is not in the full schema`);
            delete node.properties[k];
        }
        if (Array.isArray(node.required)) node.required = node.required.filter((k) => !rule.drop.includes(k));
    }
    if (typeof rule.description === 'string') node.description = rule.description;
}

function projectOne(tool) {
    const rule = CORE_PRUNE[tool?.function?.name];
    // The schemas are plain JSON (module constants, no functions), so a
    // JSON round trip is a faithful deep clone — and the only mutation
    // below is on the clone.
    const out = JSON.parse(JSON.stringify(tool));
    if (!rule) return out;
    const fn = out.function;
    if (typeof rule.description === 'string') fn.description = rule.description;
    if (rule.batchOnly) {
        const key = rule.batchOnly.key;
        const batch = fn.parameters.properties[key];
        if (!batch) throw new Error(`schemasCore: ${fn.name}.${key} is not in the full schema`);
        fn.parameters.properties = { [key]: batch };
        fn.parameters.required = [key];
        // The batch parameter's own description still says "instead of the
        // single form" — there is no single form here.
        batch.description = `Up to ${MAX_BATCH_PATCHES_PER_CALL} patches, applied in order.`;
    }
    if (rule.keep || rule.drop) applyKeepDrop(fn.parameters, { keep: rule.keep, drop: rule.drop }, fn.name);
    for (const [path, sub] of Object.entries(rule.at || {})) {
        const node = nodeAt(fn.parameters, path);
        if (!node) throw new Error(`schemasCore: ${fn.name}.${path} is not in the full schema`);
        applyKeepDrop(node, sub, `${fn.name}.${path}`);
    }
    return out;
}

const _cache = new WeakMap();

/**
 * @param {Array} toolSchemas  the FULL list (or an already-filtered subset of it)
 * @returns {Array} the same tools, core-pruned, in the same order — frozen and
 *   cached per input array, so two turns get the identical object graph.
 */
function projectCoreToolSchemas(toolSchemas) {
    const list = Array.isArray(toolSchemas) ? toolSchemas : [];
    const hit = _cache.get(list);
    if (hit) return hit;
    const projected = Object.freeze(list.map(projectOne).map((t) => deepFreeze(t)));
    _cache.set(list, projected);
    return projected;
}

function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const k of Object.keys(v)) deepFreeze(v[k]);
    }
    return v;
}

module.exports = { projectCoreToolSchemas, CORE_PRUNE, nodeAt };
