// @typecheck
const cmsStore = require('../stores/cmsStore');
const { validateStylePatch } = require('./blockStyle');
const { BLOCK_DEFAULTS } = require('../i18n/defaults/cmsDefaults');
const { isPlainObject, clone, deepMerge, newBlockId, pageIdsHint, blockIdsHint, typesHint, findIndexEntry, getPageDoc, persistPage } = require('./builderToolsShared');

const MAX_BLOCKS_PER_CALL = 10;

/** Resolve an insert position → index into `blocks`, or { error }. */
function resolveInsertIndex(blocks, position, page) {
    if (position === undefined || position === null || position === 'end') return { index: blocks.length };
    if (isPlainObject(position)) {
        if (typeof position.afterBlockId === 'string') {
            const at = blocks.findIndex((b) => b.id === position.afterBlockId);
            if (at < 0) {
                return {
                    error: `position.afterBlockId ${JSON.stringify(position.afterBlockId)} is not a block on this page.`,
                    _fixHint: blockIdsHint(page),
                };
            }
            return { index: at + 1 };
        }
        if (Number.isInteger(position.index)) {
            return { index: Math.max(0, Math.min(blocks.length, position.index)) };
        }
    }
    return { error: 'position must be "end", { afterBlockId } or { index }.' };
}

async function applyAddBlocks(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const list = Array.isArray(args?.blocks) ? args.blocks : null;
    if (!list || !list.length) {
        return { error: 'blocks must be a non-empty array of { type, content? }.', _fixHint: typesHint() };
    }
    if (list.length > MAX_BLOCKS_PER_CALL) {
        return { error: `blocks: max ${MAX_BLOCKS_PER_CALL} per call — split the work into two calls.` };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };

    const pos = resolveInsertIndex(doc.blocks || [], args.position, doc);
    if (pos.error) return pos;

    const minted = [];
    const dropped = [];
    const warnings = [];
    list.forEach((entry, i) => {
        if (!isPlainObject(entry) || typeof entry.type !== 'string' || !entry.type.trim()) {
            dropped.push({ index: i, type: entry && entry.type ? entry.type : null, reason: 'missing-type' });
            return;
        }
        // Canonicalize the type through the store's own alias logic (a probe
        // through sanitizeBlocks) so client/server agree on what survives.
        const probe = cmsStore.sanitizeBlocks([{ type: entry.type, content: {} }]);
        if (!probe.blocks.length) {
            dropped.push({ index: i, type: entry.type, reason: 'unknown-type' });
            return;
        }
        const type = probe.blocks[0].type;
        if (type !== entry.type) warnings.push(`blocks[${i}]: type "${entry.type}" was normalized to "${type}".`);
        const content = deepMerge(BLOCK_DEFAULTS[type] || {}, isPlainObject(entry.content) ? entry.content : {});
        let style = {};
        if (entry.style !== undefined) {
            const validated = validateStylePatch(entry.style);
            if ('error' in validated) {
                dropped.push({ index: i, type: entry.type, reason: 'invalid-style', message: validated.error, _fixHint: validated._fixHint });
                return;
            }
            style = validated.style;
            for (const h of validated.hints) warnings.push(`blocks[${i}]: ${h}`);
        }
        minted.push({ id: newBlockId(), type, enabled: true, content, style });
    });

    if (!minted.length) {
        const typeDrops = dropped.filter((d) => d.reason !== 'invalid-style');
        const styleDrops = dropped.filter((d) => d.reason === 'invalid-style');
        const noun = `entr${list.length === 1 ? 'y' : 'ies'}`;
        const causes = [];
        if (typeDrops.length) causes.push(`unknown or missing types (${typeDrops.map((d) => JSON.stringify(d.type)).join(', ')})`);
        if (styleDrops.length) causes.push(`an invalid style (${styleDrops.map((d) => d.message).join('; ')})`);
        // A style rejection carries its own hint; the type list only helps
        // when a type was the cause.
        const hints = [];
        if (typeDrops.length) hints.push(typesHint());
        for (const d of styleDrops) if (d._fixHint) hints.push(d._fixHint);
        return {
            error: `No blocks added — all ${list.length} ${noun} had ${causes.join(' and ')}.`,
            _fixHint: hints.join(' '),
            dropped,
        };
    }

    const { page } = await persistPage(draftWrap, pageId, (d) => {
        const blocks = [...(d.blocks || [])];
        // The index was resolved against the copy this turn loaded; on a newer
        // version keep the same anchor when it still exists, else clamp.
        const anchor = isPlainObject(args.position) && typeof args.position.afterBlockId === 'string'
            ? resolveInsertIndex(blocks, args.position, d) : null;
        const at = anchor && !anchor.error ? anchor.index : Math.min(pos.index, blocks.length);
        blocks.splice(at, 0, ...minted);
        return { ...d, blocks };
    });
    const survivors = new Set(page.blocks.map((b) => b.id));
    const result = {
        pageId,
        blockIds: minted.map((b) => b.id).filter((id) => survivors.has(id)),
        dropped,
        warnings,
    };
    if (dropped.length) {
        result._fixHint = `${dropped.length} block(s) dropped (${dropped.map((d) => JSON.stringify(d.type)).join(', ')}). ${typesHint()}`;
    }
    return result;
}

async function applyUpdateBlock(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    const blockId = typeof args?.blockId === 'string' ? args.blockId : null;
    const idx = (doc.blocks || []).findIndex((b) => b.id === blockId);
    if (idx < 0) {
        return { error: `Unknown blockId ${JSON.stringify(blockId)} on page ${pageId}.`, _fixHint: blockIdsHint(doc) };
    }
    const hasContent = isPlainObject(args.contentPatch) && Object.keys(args.contentPatch).length > 0;
    const hasStyle = isPlainObject(args.stylePatch) && Object.keys(args.stylePatch).length > 0;
    const hasEnabled = typeof args.enabled === 'boolean';
    if (!hasContent && !hasStyle && !hasEnabled) {
        return { error: 'Nothing to change — pass contentPatch, stylePatch and/or enabled.' };
    }

    let styleHints = [];
    let validatedStyle = null;
    if (hasStyle) {
        const validated = validateStylePatch(args.stylePatch);
        if (validated.error) return validated;
        styleHints = validated.hints;
        validatedStyle = validated.style;
    }
    // Applied to the block as stored NOW, so a patch on one field never undoes
    // a patch another call made to the same block a moment ago.
    const patchBlock = (block) => {
        const next = clone(block);
        if (hasContent) next.content = deepMerge(block.content, args.contentPatch);
        if (validatedStyle) {
            const mergedStyle = { ...(isPlainObject(block.style) ? clone(block.style) : {}) };
            for (const [k, v] of Object.entries(validatedStyle)) {
                if ((k === 'colorOverrides' || k === 'spacing') && isPlainObject(mergedStyle[k])) {
                    mergedStyle[k] = { ...mergedStyle[k], ...v };
                } else {
                    mergedStyle[k] = v;
                }
            }
            next.style = mergedStyle;
        }
        if (hasEnabled) next.enabled = args.enabled;
        return next;
    };

    const { page } = await persistPage(draftWrap, pageId, (d) => {
        const at = (d.blocks || []).findIndex((b) => b.id === blockId);
        if (at < 0) throw new Error(`Block ${JSON.stringify(blockId)} was removed from page ${pageId} by another edit.`);
        const blocks = [...d.blocks];
        blocks[at] = patchBlock(d.blocks[at]);
        return { ...d, blocks };
    });
    const saved = page.blocks.find((b) => b.id === blockId);
    const result = { pageId, blockId, type: saved?.type, enabled: saved ? saved.enabled : patchBlock(doc.blocks[idx]).enabled };
    if (styleHints.length) result._hints = styleHints;
    return result;
}

async function applyRemoveBlock(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    const blockId = typeof args?.blockId === 'string' ? args.blockId : null;
    if (!(doc.blocks || []).some((b) => b.id === blockId)) {
        return { error: `Unknown blockId ${JSON.stringify(blockId)} on page ${pageId}.`, _fixHint: blockIdsHint(doc) };
    }
    await persistPage(draftWrap, pageId, (d) => ({ ...d, blocks: (d.blocks || []).filter((b) => b.id !== blockId) }));
    // Server twin of the admin panel's client-side pruning: drop every
    // locale's translation entry for the removed block.
    const prunedLocales = await cmsStore.pruneBlockLocaleOverrides(draftWrap.siteId, pageId, blockId);
    return { pageId, removed: blockId, prunedLocales };
}

async function applyReorderBlocks(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    const ordered = Array.isArray(args?.orderedBlockIds) ? args.orderedBlockIds : null;
    if (!ordered) return { error: 'orderedBlockIds must be an array of block ids.', _fixHint: blockIdsHint(doc) };

    const current = (doc.blocks || []).map((b) => b.id);
    const currentSet = new Set(current);
    const orderedSet = new Set(ordered);
    const missing = current.filter((id) => !orderedSet.has(id));
    const extra = ordered.filter((id) => !currentSet.has(id));
    if (missing.length || extra.length || ordered.length !== current.length) {
        const bits = [];
        if (missing.length) bits.push(`missing: ${missing.join(', ')}`);
        if (extra.length) bits.push(`unknown/extra: ${extra.join(', ')}`);
        if (!missing.length && !extra.length) bits.push('duplicate ids in orderedBlockIds');
        return {
            error: `orderedBlockIds must be exactly the page's current block ids in a new order (${bits.join('; ')}).`,
            _fixHint: blockIdsHint(doc),
        };
    }
    await persistPage(draftWrap, pageId, (d) => {
        const byId = new Map((d.blocks || []).map((b) => [b.id, b]));
        // Blocks another edit added meanwhile are not in `ordered`: keep them, at the end.
        const placed = ordered.filter((id) => byId.has(id));
        const placedSet = new Set(placed);
        const blocks = [...placed.map((id) => byId.get(id)), ...(d.blocks || []).filter((b) => !placedSet.has(b.id))];
        return { ...d, blocks };
    });
    return { pageId, order: ordered };
}

module.exports = { MAX_BLOCKS_PER_CALL, resolveInsertIndex, applyAddBlocks, applyUpdateBlock, applyRemoveBlock, applyReorderBlocks };
