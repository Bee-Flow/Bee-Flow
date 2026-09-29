// Inline iframe edits (cms-edit) + block CRUD + canvas block-toolbar actions
// of the ProductWebsitePanel container — moved verbatim from
// ProductWebsitePanel.jsx. State stays owned by the panel (threaded in).
/* eslint-disable react-hooks/preserve-manual-memoization -- verbatim move
   out of ProductWebsitePanel.jsx: the React Compiler lint can no longer see
   that the threaded panel refs/setters are stable, so it reports advisory
   "compilation skipped" notes; the dep arrays are unchanged from the
   original component. */
import { useCallback } from 'react';
import scopedStorage from '../../../../utils/scopedStorage';
import { BLOCK_DEFAULTS } from '../editors';
import { cloneBlock, newBlockId } from './helpers';
import { applyChromeEdit, chromeStoragePath } from '../preview/previewContent';

export default function useCmsBlockEditing({
    site, activePage, activeBlockId, setActiveBlockId, activeLocale, translationMode,
    history, pagesStateRef, updatePage, updateSiteOverride, updatePageOverride,
    localeOverridesRef, setLocaleOverrides, scheduleSave,
    setAddBlockRequest, setInspectorOpen,
}) {
    // The history object is rebuilt per render; its commit is a stable callback.
    const commitHistory = history.commit;

    // Inline text edit from iframe postMessage (path = "blockType.field.subfield").
    //
    // The section components in agent-hub/src/marketing/sections/ hard-code
    // the block type as the path root (e.g. EditableText path="hero.lead"),
    // which is only block-*type*-relative. To write to the right block when a
    // page has several of the same type, EditableText also stamps the block's
    // unique id (threaded via BlockIdContext from ProductWebsite.jsx) onto the
    // cms-edit message — we resolve the target by that id here. `blockId` is
    // absent only for site chrome (header/footer), handled by the prefix
    // branch below, and for legacy messages, where we fall back to first-of-type.
    const applyIframeEdit = useCallback((path, value, blockId = null) => {
        // Announcement bar — checked BEFORE the translation branch on
        // purpose. Its `text` blob carries every locale inside the BASE
        // SiteDoc (same model as cookieBanner: no locale-override layer),
        // and the path already names the locale it belongs to
        // (announcement.text.<lang>.message), so an inline edit always
        // writes straight through — including while translation mode is on.
        if (path.startsWith('announcement.') && site) {
            const next = applyChromeEdit(site, path, value);
            if (next) commitHistory({ site: next, pages: pagesStateRef.current });
            return;
        }

        // Translation mode: the edit is a TEXT translation, not a structural
        // change — write a sparse leaf into the active locale's override
        // instead of mutating the default-locale base doc.
        if (translationMode) {
            if (path.startsWith('header.') || path.startsWith('footer.')) {
                const storagePath = chromeStoragePath(path);
                if (storagePath) updateSiteOverride(activeLocale, storagePath, value);
                return;
            }
            if (!activePage) return;
            const parts = path.split('.');
            const fieldPath = parts.slice(1).map(seg => /^\d+$/.test(seg) ? Number(seg) : seg);
            const targetId = blockId
                || activePage.blocks?.find(b => b.type === parts[0])?.id;
            if (!targetId) return;
            updatePageOverride(activePage.id, activeLocale, ['blocks', targetId, 'content', ...fieldPath], value);
            return;
        }

        // Site-chrome paths (header.* / footer.*) target the SiteDoc, not a
        // page block. The iframe receives chrome in a re-shaped form
        // (buildPreviewContent below) — e.g. footer.brand.blurb is the
        // display path while the SiteDoc stores it at footer.blurb. We
        // resolve the iframe path back to the SiteDoc path here and write
        // straight through setSiteDoc + scheduleSave('site', …) (mirrors
        // updateSiteChrome — inlined to avoid a TDZ on its declaration,
        // which lives further down).
        if ((path.startsWith('header.') || path.startsWith('footer.')) && site) {
            const next = applyChromeEdit(site, path, value);
            if (next) {
                // Same write path as updateSiteChrome — one history entry
                // per inline chrome edit (EditableText commits on blur).
                commitHistory({ site: next, pages: pagesStateRef.current });
            }
            return;
        }

        if (!activePage) return;
        const parts = path.split('.');
        const blockType = parts[0];
        // Convert numeric segments to actual numbers so paths into arrays
        // (e.g. content.columns.0.elements.1.body) recognise the array
        // indices when we walk + clone. With strings, the recursive
        // `Array.isArray(cur[k]) ? [...] : {...}` decision still works for
        // SETTING the leaf, but only if the array has been pre-allocated
        // by the editor — which it will be once the new Content shape
        // lands. Numeric coercion keeps things consistent either way.
        const fieldPath = parts.slice(1).map(seg => /^\d+$/.test(seg) ? Number(seg) : seg);

        updatePage(activePage.id, p => {
            let matched = false;
            return {
                ...p,
                blocks: p.blocks.map(b => {
                    // Prefer the exact block by id (unique, so no ambiguity
                    // between blocks of the same type). Only when no id was
                    // supplied (legacy message) do we fall back to the old
                    // first-block-of-type behaviour.
                    const isTarget = blockId
                        ? b.id === blockId
                        : (!matched && b.type === blockType);
                    if (!isTarget) return b;
                    matched = true;
                    const content = JSON.parse(JSON.stringify(b.content));
                    let cur = content;
                    for (let i = 0; i < fieldPath.length - 1; i++) {
                        const k = fieldPath[i];
                        // Pick the right shape for the next level: numeric
                        // *next* segment → array; string → object.
                        const nextIsArrayIndex = typeof fieldPath[i + 1] === 'number';
                        if (nextIsArrayIndex) {
                            cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : [];
                        } else {
                            cur[k] = (cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k]))
                                ? { ...cur[k] }
                                : (Array.isArray(cur[k]) ? [...cur[k]] : {});
                        }
                        cur = cur[k];
                    }
                    cur[fieldPath[fieldPath.length - 1]] = value;
                    return { ...b, content };
                }),
            };
        });
    }, [activePage, updatePage, site, commitHistory, pagesStateRef, translationMode, activeLocale, updateSiteOverride, updatePageOverride]);

    // ── block CRUD ───────────────────────────────────────────────────

    // `atIndex` (optional) = explicit splice position from the canvas
    // insert-between "+" zones; when omitted/null the block lands AFTER the
    // active block (fall back to append) — adding a section next to what
    // you're looking at instead of at the page end.
    // `contentOverrides` (optional) is spread over the type's defaults —
    // used by the AddBlockDialog's variant strip to add a block with a
    // specific layout variant pre-selected ({ variant: 'bento' } etc.).
    const addBlock = useCallback((type, atIndex = null, contentOverrides = null) => {
        if (!activePage) return;
        const block = {
            id: newBlockId(),
            type,
            enabled: true,
            content: {
                ...JSON.parse(JSON.stringify(BLOCK_DEFAULTS[type] || {})),
                ...(contentOverrides || {}),
            },
            style: {},
        };
        updatePage(activePage.id, p => {
            const blocks = [...p.blocks];
            const idx = Number.isInteger(atIndex)
                ? Math.max(0, Math.min(atIndex, blocks.length))
                : (() => {
                    const activeIdx = activeBlockId ? p.blocks.findIndex(b => b.id === activeBlockId) : -1;
                    return activeIdx >= 0 ? activeIdx + 1 : blocks.length;
                })();
            blocks.splice(idx, 0, block);
            return { ...p, blocks };
        });
        setActiveBlockId(block.id);
    }, [activePage, activeBlockId, updatePage, setActiveBlockId]);

    const toggleBlock = useCallback((blockId) => {
        if (!activePage) return;
        updatePage(activePage.id, p => ({
            ...p,
            blocks: p.blocks.map(b => b.id === blockId ? { ...b, enabled: !b.enabled } : b),
        }));
    }, [activePage, updatePage]);

    const duplicateBlock = useCallback((blockId) => {
        if (!activePage) return;
        updatePage(activePage.id, p => {
            const idx = p.blocks.findIndex(b => b.id === blockId);
            if (idx < 0) return p;
            const copy = cloneBlock(p.blocks[idx]);
            const blocks = [...p.blocks];
            blocks.splice(idx + 1, 0, copy);
            setActiveBlockId(copy.id);
            return { ...p, blocks };
        });
    }, [activePage, updatePage, setActiveBlockId]);

    const deleteBlock = useCallback((blockId) => {
        if (!activePage) return;
        const pageId = activePage.id;
        updatePage(pageId, p => {
            const blocks = p.blocks.filter(b => b.id !== blockId);
            if (activeBlockId === blockId) setActiveBlockId(blocks[0]?.id || null);
            return { ...p, blocks };
        });
        // Prune this block's per-locale translation overrides too — they're
        // keyed by block id, so without this they linger as orphaned cruft
        // (and resurface in exports) after the block is gone.
        const prev = localeOverridesRef.current;
        const perLocale = prev.pagesByLocale?.[pageId];
        if (perLocale) {
            let changed = false;
            const nextPerLocale = {};
            for (const [locale, ov] of Object.entries(perLocale)) {
                if (ov?.blocks && Object.prototype.hasOwnProperty.call(ov.blocks, blockId)) {
                    const nextBlocks = { ...ov.blocks };
                    delete nextBlocks[blockId];
                    const nextOv = { ...ov, blocks: nextBlocks };
                    nextPerLocale[locale] = nextOv;
                    scheduleSave(`locale:page:${pageId}:${locale}`, nextOv);
                    changed = true;
                } else {
                    nextPerLocale[locale] = ov;
                }
            }
            if (changed) {
                const updated = { ...prev, pagesByLocale: { ...prev.pagesByLocale, [pageId]: nextPerLocale } };
                localeOverridesRef.current = updated;
                setLocaleOverrides(updated);
            }
        }
    }, [activePage, activeBlockId, updatePage, scheduleSave, localeOverridesRef, setActiveBlockId, setLocaleOverrides]);

    const reorderBlocks = useCallback((nextBlocks) => {
        if (!activePage) return;
        updatePage(activePage.id, p => ({ ...p, blocks: nextBlocks }));
    }, [activePage, updatePage]);

    // Canvas block-toolbar actions (iframe → cms-block-action). Every
    // mutation REUSES the existing block mutators above, so history +
    // debounced autosave semantics are byte-identical to the sidebar
    // buttons — zero new save paths. The builderRunning stream-lock gate
    // lives at the single onMessage choke point below, not here.
    const handleBlockAction = useCallback((blockId, action) => {
        if (!activePage) return;
        const blocks = activePage.blocks || [];
        const idx = blocks.findIndex(b => b.id === blockId);
        if (idx < 0) return;
        if (action === 'move-up' || action === 'move-down') {
            const to = action === 'move-up' ? idx - 1 : idx + 1;
            if (to < 0 || to >= blocks.length) return;
            const next = [...blocks];
            const [moved] = next.splice(idx, 1);
            next.splice(to, 0, moved);
            reorderBlocks(next);
            return;
        }
        if (action === 'duplicate') { duplicateBlock(blockId); return; }
        // Delete matches BlockList's row button: no confirm (undo covers it).
        if (action === 'delete') { deleteBlock(blockId); return; }
        if (action === 'settings') {
            setActiveBlockId(blockId);
            // Open the inspector if it's collapsed — same persistence
            // convention as toggleInspector.
            scopedStorage.setItem('cmsInspectorOpen', '1');
            setInspectorOpen(true);
        }
    }, [activePage, reorderBlocks, duplicateBlock, deleteBlock, setActiveBlockId, setInspectorOpen]);

    // Canvas insert-between "+" (iframe → cms-insert-at): open the
    // Add-block dialog with a pending explicit insertion index.
    const handleInsertAt = useCallback((index) => {
        if (!activePage) return;
        setAddBlockRequest({ index });
    }, [activePage, setAddBlockRequest]);

    return {
        applyIframeEdit, addBlock, toggleBlock, duplicateBlock, deleteBlock,
        reorderBlocks, handleBlockAction, handleInsertAt,
    };
}
