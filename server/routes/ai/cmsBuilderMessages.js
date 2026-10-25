// @typecheck
'use strict';
// Pure prompt and payload builders of the CMS builder route (cmsBuilder.js):
// machine-message renderers, history/context sanitisers, tool labels and
// summaries. No SSE, no I/O; the route keeps every write and await.

const { renderDraftState } = require('../../cmsBuilder/builderPrompt');

// ── Helpers ─────────────────────────────────────────────────────────

// Marker prefixes for the synthetic machine messages — framed as
// machine-generated (not the human) and stripped from cross-turn history.
const VALIDATION_NOTE_PREFIX = '[VALIDATION REPORT — machine-generated, not from the human user]';
const DRAFT_STATE_PREFIX = '[SITE STATE — machine-generated: the site\'s current pages and blocks with their REAL ids]';
const EDITOR_CONTEXT_PREFIX = '[EDITOR CONTEXT — machine-generated: what the user is looking at]';
const BLOCK_FEEDBACK_PREFIX = '[BLOCK FEEDBACK — machine-generated]';

function renderValidationNote(validation) {
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
    const warnLine = warnings.length
        ? `\nwarnings(${warnings.length}): ${[...new Set(warnings.map((w) => w && w.code).filter(Boolean))].join(', ')}`
        : '';
    return `${VALIDATION_NOTE_PREFIX}\nFix every error below before you finish. Each record has {code, path, message, hint}; the hint tells you what to do next.\n${JSON.stringify(errors)}${warnLine}`;
}

function renderBlockFeedbackNote(droppedTypes) {
    const { BLOCK_TYPE_IDS } = require('../../i18n/defaults/cmsDefaults');
    return `${BLOCK_FEEDBACK_PREFIX}\nYour cms_add_blocks call included unknown block type(s): ${[...new Set(droppedTypes)].map((t) => JSON.stringify(t)).join(', ')} — those blocks were DROPPED and are NOT on the page. Re-add that content using only the valid types: ${BLOCK_TYPE_IDS.join(', ')}.`;
}

/** Draft state + editor context, folded into one late machine message. */
function renderDraftStateNote(draftWrap, editorContext) {
    const parts = [`${DRAFT_STATE_PREFIX}\n${renderDraftState(draftWrap, editorContext)}`];
    const contextNote = renderEditorContextNote(editorContext);
    if (contextNote) parts.push(contextNote);
    return parts.join('\n');
}

// ── Editor context — whitelisted, bounded projection of body.context ──

const CONTEXT_STRING_KEYS = ['activePageId', 'activeBlockId', 'activeLocale'];
const MAX_CONTEXT_ID_LEN = 64;

/** Whitelist + bound the client's editor context; null when nothing usable. */
function sanitizeEditorContext(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const key of CONTEXT_STRING_KEYS) {
        const v = raw[key];
        if (typeof v === 'string' && v && v.length <= MAX_CONTEXT_ID_LEN) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
}

function renderEditorContextNote(context) {
    if (!context) return null;
    const lines = [EDITOR_CONTEXT_PREFIX];
    if (context.activePageId) lines.push(`open page: ${context.activePageId}`);
    if (context.activeBlockId) lines.push(`selected block: ${context.activeBlockId}`);
    if (context.activeLocale) lines.push(`viewing locale: ${context.activeLocale}`);
    lines.push('When the user says "this"/"here", they most likely mean the ids above.');
    return lines.join('\n');
}

/** Prose-only history from a session snapshot; loop-internal notes stripped. */
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .filter((m) => !m.content.startsWith(VALIDATION_NOTE_PREFIX)
            && !m.content.startsWith(DRAFT_STATE_PREFIX)
            && !m.content.startsWith(EDITOR_CONTEXT_PREFIX)
            && !m.content.startsWith(BLOCK_FEEDBACK_PREFIX))
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-40);
}

// Product-language labels for the tool_call SSE event.
const TOOL_LABELS = {
    cms_create_page: 'Created page',
    cms_update_page_meta: 'Updated page settings',
    cms_update_page_seo: 'Updated SEO',
    cms_add_blocks: 'Added blocks',
    cms_update_block: 'Edited block',
    cms_remove_block: 'Removed block',
    cms_reorder_blocks: 'Reordered blocks',
    cms_set_homepage: 'Set homepage',
    cms_reorder_pages: 'Reordered pages',
    cms_update_header_nav: 'Updated header menu',
    cms_update_design: 'Updated design',
    cms_list_site: 'Read site',
    cms_get_page: 'Read page',
};

function labelForTool(name) {
    return TOOL_LABELS[name] || name;
}

/** One short human line per tool result — feeds the tool_call SSE event. */
function summariseToolResult(name, args, result) {
    const cap = (s) => {
        const str = String(s || '').replace(/\s+/g, ' ').trim();
        return str.length > 140 ? `${str.slice(0, 140)}…` : str;
    };
    if (result && typeof result === 'object' && result.error) return cap(result.error);
    switch (name) {
        case 'cms_list_site': return cap(`${Array.isArray(result?.pages) ? result.pages.length : 0} page(s) on the site`);
        case 'cms_get_page': return cap(`Read page ${result?.meta?.slug ? `/${result.meta.slug}` : args?.pageId}`);
        case 'cms_create_page': return cap(`Created "${result?.title || args?.title}" at /${result?.slug}`);
        case 'cms_update_page_meta': return cap(`Updated settings for ${result?.page?.slug ? `/${result.page.slug}` : args?.pageId}`);
        case 'cms_update_page_seo': return cap(`Updated SEO for ${args?.pageId}`);
        case 'cms_add_blocks': {
            const added = Array.isArray(result?.blockIds) ? result.blockIds.length : 0;
            const dropped = Array.isArray(result?.dropped) ? result.dropped.length : 0;
            return cap(`Added ${added} block(s)${dropped ? `, ${dropped} dropped (unknown type)` : ''}`);
        }
        case 'cms_update_block': return cap(`Edited ${result?.type || 'block'} ${args?.blockId}${result?.enabled === false ? ' (hidden)' : ''}`);
        case 'cms_remove_block': return cap(`Removed block ${result?.removed || args?.blockId}`);
        case 'cms_reorder_blocks': return cap(`Reordered ${Array.isArray(result?.order) ? result.order.length : 0} block(s)`);
        case 'cms_set_homepage': return cap(`Homepage is now ${result?.homepageId || args?.pageId}`);
        case 'cms_reorder_pages': return cap(`Reordered ${Array.isArray(result?.order) ? result.order.length : 0} page(s)`);
        case 'cms_update_header_nav': return cap(`${Number.isFinite(result?.navCount) ? result.navCount : 0} menu item(s) in the header`);
        // The summary is built from the PERSISTED design (builderTools
        // re-reads after the write), so this line never over-promises.
        case 'cms_update_design': return cap(result?.summary || 'Design updated');
        default: return '';
    }
}

// Tools that legitimately take NO arguments — empty args must not be treated
// as a truncated call.
const PARAMLESS_TOOLS = new Set(['cms_list_site']);

/**
 * Parse a tool call's `arguments` defensively → { args, truncated }.
 * `truncated` only fires when a NON-EMPTY string fails to parse for a tool
 * that takes parameters (the signature of a response cut off mid-call).
 */
function parseToolArgs(raw, toolName) {
    if (raw && typeof raw === 'object') return { args: raw, truncated: false };
    if (typeof raw !== 'string') return { args: {}, truncated: false };
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '{}') return { args: {}, truncated: false };
    try { return { args: JSON.parse(trimmed), truncated: false }; }
    catch { return { args: {}, truncated: !PARAMLESS_TOOLS.has(toolName) }; }
}

/** JSON-safe truncation for model-facing tool messages (never cuts mid-JSON). */
function truncateJson(result, maxChars = 30_000) {
    let s;
    try { s = JSON.stringify(result); } catch (_) { return JSON.stringify({ error: 'unserializable tool result' }); }
    if (typeof s !== 'string') return JSON.stringify(null);
    if (s.length <= maxChars) return s;
    return JSON.stringify({ _truncated: true, preview: s.slice(0, Math.max(0, maxChars - 200)) });
}

module.exports = {
    VALIDATION_NOTE_PREFIX,
    DRAFT_STATE_PREFIX,
    EDITOR_CONTEXT_PREFIX,
    BLOCK_FEEDBACK_PREFIX,
    renderValidationNote,
    renderBlockFeedbackNote,
    renderDraftStateNote,
    sanitizeEditorContext,
    renderEditorContextNote,
    sanitizeHistory,
    labelForTool,
    summariseToolResult,
    parseToolArgs,
    truncateJson,
};

/** @typedef {{ activePageId?: string, activeBlockId?: string, activeLocale?: string }} EditorContext */
