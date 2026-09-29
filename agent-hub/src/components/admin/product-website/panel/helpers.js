// Shared module-scope constants + pure helpers for the ProductWebsitePanel
// container. Extracted verbatim from ProductWebsitePanel.jsx (no behavior
// change) so the panel's custom hooks in this folder can import them.
import { BLOCK_CATALOGUE } from '../editors';

export const ACTIVE_SITE_LS_KEY = 'cms.activeSiteId';

export function newBlockId() {
    return `blk_${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneBlock(block) {
    return { ...JSON.parse(JSON.stringify(block)), id: newBlockId() };
}

// Block-type → human label map for the canvas chrome. Built once from
// BLOCK_CATALOGUE and shipped inside the cms-active message, so the
// preview iframe (marketing bundle) never imports admin code for labels.
export const BLOCK_LABELS = Object.fromEntries(
    Object.values(BLOCK_CATALOGUE).map(m => [m.type, m.label]));

export const AI_LOCK_MSG = 'The AI assistant is editing — press Stop in the assistant to take over.';
