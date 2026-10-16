/**
 * CMS builder — function-calling tool schemas (OpenAI format).
 *
 * The apply() implementations live in ./builderTools.js; this file is the
 * single place the LLM-facing surface is declared (mirrors
 * appStudio/builderTools/schemas.js). Block/content detail is NOT repeated
 * here — the system prompt (./builderPrompt.js) renders the full
 * BLOCK_DEFAULTS catalogue; these descriptions only teach the call protocol.
 *
 * CLOSED SET — exactly 13 tools. Page delete, footer/cookie-banner edits,
 * locale overrides and publishing are deliberately NOT tools (the system
 * prompt redirects the user for those). The header MENU and the site DESIGN
 * are the two pieces of site chrome that ARE editable — via
 * cms_update_header_nav and cms_update_design.
 */

'use strict';

const {
    DESIGN_COMPONENT_ENUMS, DESIGN_LAYOUT_ENUMS, DESIGN_THEMES, DESIGN_MOTIONS, DARK_BANDS,
    DISPLAY_SIZES, HEADING_WEIGHTS, DISPLAY_TRACKINGS, BODY_SIZES, COLOR_KEYS, BLANKABLE_COLORS, DARK_COLOR_KEYS, DESIGN_FONTS,
} = require('../i18n/defaults/cmsDefaults');
const { THEME_PRESET_IDS } = require('../i18n/defaults/themePresets');

const LINK_HINT = 'Links are objects: {kind:"page",pageId} | {kind:"external",url,newTab?} | {kind:"anchor",anchor} | {kind:"app",path}. Use REAL page ids from the draft state.';

const enumList = (enums) => Object.entries(enums).map(([k, v]) => `${k} (${v.join('|')})`).join(', ');

/**
 * The single teaching string for cms_update_design — rendered once at module
 * load from the schema-of-record constants, embedded in the tool description
 * AND reused verbatim as the `_fixHint` on every rejection (builderTools.js).
 * sanitizeDesign() in the store silently coerces instead of rejecting, so the
 * tool owns 100% of design validation and this is what teaches the model the
 * legal vocabulary.
 */
const DESIGN_HINT = [
    `colorsPatch keys: ${COLOR_KEYS.join(', ')}.`,
    `darkColorsPatch keys: ${DARK_COLOR_KEYS.join(', ')}.`,
    'EVERY colour is a literal "#rrggbb" hex string — no colour names, no rgb()/hsl(), no 3-digit shorthand; darkColors.primary and darkColors.accent also accept "" meaning "reuse the light value".',
    'radius: a whole number 0-24 (px).',
    `fontsPatch keys: heading, body, mono — each value MUST be one of: ${DESIGN_FONTS.join(', ')}.`,
    `typographyPatch: displaySize (${DISPLAY_SIZES.join('|')}), headingWeight (${HEADING_WEIGHTS.join('|')}), displayTracking (${DISPLAY_TRACKINGS.join('|')}), bodySize (${BODY_SIZES.join('|')}).`,
    `componentsPatch: ${enumList(DESIGN_COMPONENT_ENUMS)}.`,
    `layoutPatch: ${enumList(DESIGN_LAYOUT_ENUMS)}.`,
    `theme (${DESIGN_THEMES.join('|')}), motion (${DESIGN_MOTIONS.join('|')}), darkBand (${DARK_BANDS.join('|')} — what a block with band 'dark' is filled with: the dark-mode background colour, or the theme's secondary colour), grain and gradient are booleans.`,
    `preset: one of ${THEME_PRESET_IDS.join(', ')}.`,
].join(' ');

const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'cms_list_site',
            description: 'Read the site overview: name, locales, design summary and every page with its slug, title, homepage flag and block outline. Use to re-orient; the same data is in the draft state each turn.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_get_page',
            description: 'Read ONE page in full: the complete PageDoc (seo + every block with id, type, content, style) plus its index metadata. Call before editing a page whose full JSON is not in the draft state.',
            parameters: {
                type: 'object',
                properties: {
                    pageId: { type: 'string', description: 'The page id (pg_…).' },
                },
                required: ['pageId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_create_page',
            description: 'Create a new page. The slug is normalized and de-duplicated automatically; reserved slugs (app, api, admin, pricing, …) are rejected. Returns { pageId, slug }. The new page starts empty — add blocks with cms_add_blocks.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Page title (also seeds the slug when no slug is given).' },
                    slug: { type: 'string', description: 'URL slug (lowercase, a-z0-9_-). Omit to derive from the title.' },
                    templateId: { type: 'string', description: 'Optional saved page template (tpl_…) to seed the blocks from.' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_update_page_meta',
            description: 'Update a page\'s settings: title, slug (normalized/deduped, reserved slugs rejected), and whether the site header/footer are hidden on it.',
            parameters: {
                type: 'object',
                properties: {
                    pageId: { type: 'string' },
                    title: { type: 'string' },
                    slug: { type: 'string' },
                    hideHeader: { type: 'boolean' },
                    hideFooter: { type: 'boolean' },
                },
                required: ['pageId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_update_page_seo',
            description: 'Update a page\'s SEO fields (merged into the existing seo object). ogImage must be an EXISTING cms/… asset key or an absolute URL — never invent asset keys.',
            parameters: {
                type: 'object',
                properties: {
                    pageId: { type: 'string' },
                    metaTitle: { type: 'string', description: 'Browser/OG title (aim for ≤60 chars).' },
                    metaDescription: { type: 'string', description: 'Search-result description (aim for ≤160 chars).' },
                    ogImage: { type: 'string', description: 'Existing cms/… asset key or absolute https URL. Empty string clears it.' },
                    noIndex: { type: 'boolean', description: 'true = ask search engines not to index this page.' },
                },
                required: ['pageId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_add_blocks',
            description: `Add 1-10 blocks to a page. Each entry is { type, content?, style? }: the block is seeded from that type's defaults, then your content is DEEP-MERGED over it — objects merge key-by-key, but ARRAYS REPLACE WHOLESALE (send the complete items/columns/stats array, never a partial one). Unknown types are dropped and reported. ${LINK_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    pageId: { type: 'string' },
                    blocks: {
                        type: 'array',
                        description: 'The blocks to add, in order (max 10 per call).',
                        items: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', description: 'A block type from the catalogue (e.g. hero, features, media-text, cta-banner).' },
                                content: { type: 'object', description: 'Partial content merged over the type\'s defaults. Arrays replace wholesale, so send the complete items/cards array: a steps items or security cards list you leave out is seeded empty (with a warning), not with example text. A content block holds columns[].elements[] of kind text, image, video, iframe or cta (button and link are accepted as cta); any other kind is dropped and reported as unknown_element_kind. Style keys (labelStyle, band, rhythm, columns, …) belong in style, not here.' },
                                style: { type: 'object', description: 'Optional block style wrapper (band, rhythm, colorOverrides, cssClass, … — the same closed key set as cms_update_block\'s stylePatch). An invalid value drops that entry and says why.' },
                            },
                            required: ['type'],
                        },
                    },
                    position: {
                        description: 'Where to insert: "end" (default), {afterBlockId:"blk_…"} or {index:0-based}.',
                        anyOf: [
                            { type: 'string', enum: ['end'] },
                            {
                                type: 'object',
                                properties: {
                                    afterBlockId: { type: 'string' },
                                    index: { type: 'number' },
                                },
                            },
                        ],
                    },
                },
                required: ['pageId', 'blocks'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_update_block',
            description: `Edit one block in place. contentPatch DEEP-MERGES into the block's content (arrays replace wholesale — resend the whole array to change one item). stylePatch merges into the block's style wrapper: colorOverrides {primary,secondary,accent,background,surface,textPrimary,textSecondary}, spacing {paddingTop,paddingBottom}, backgroundImage, backgroundOverlay, backgroundSize (cover|contain|auto|a width such as "480px" — placement of backgroundImage), backgroundPosition (top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right), backgroundRepeat (no-repeat|repeat|repeat-x|repeat-y), backgroundHideMobile (boolean — hide the background image on phones), motif (none|honeycomb — the built-in brand honeycomb pattern in the brand colours, no upload needed), motifSide (right|left|center — where the motif sits), motifTiles (boolean — add filled hexagon tiles to the motif), decor (default|none — none switches off the hero's blurred colour blobs), cardFill (tint|white|none — fill of the cards inside the block; white makes cards stand out on a tinted band), labelStyle (mono|plain — trust-band chip labels: monospace uppercase, or plain sentence case in the body font), tileShape (default|square|rounded|circle|hexagon), tileFill (default|tint|solid|none), tileSize (default|sm|lg), tileIconColor (default|light|dark — icon tile look of the feature/security/integration cards in this block; default follows the theme-wide Design setting), maxWidth (narrow|medium|wide|full), align (left|center|right), cssClass, band (default|surface|tint|dark|primary — section background treatment, works on every type; 'dark' is the premium charcoal band), rhythm (tight|compact|default|spacious — vertical padding preset), reveal (on|off — entrance animation), glow (boolean — soft accent glow behind the block), anchor (slug — the section's id so a link can jump to it: {kind:"anchor", anchor:"install"} or /page#install; lowercase letters, digits and single hyphens, starting with a letter, at most 64 characters, unique per page), columns (2|3|4 — column count; features/steps/security/techStats cards and trust-band chips only). enabled=false hides the block without deleting it. ${LINK_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    pageId: { type: 'string' },
                    blockId: { type: 'string', description: 'The block id (blk_…).' },
                    contentPatch: { type: 'object', description: 'Partial content, deep-merged (arrays replace wholesale).' },
                    stylePatch: { type: 'object', description: 'Partial style wrapper (see the description for the closed key set).' },
                    enabled: { type: 'boolean', description: 'Show/hide the block.' },
                },
                required: ['pageId', 'blockId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_remove_block',
            description: 'Remove one block from a page (its translations are cleaned up automatically). Prefer cms_update_block {enabled:false} when the user might want it back.',
            parameters: {
                type: 'object',
                properties: {
                    pageId: { type: 'string' },
                    blockId: { type: 'string' },
                },
                required: ['pageId', 'blockId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_reorder_blocks',
            description: 'Reorder a page\'s blocks. orderedBlockIds must contain EXACTLY the page\'s current block ids (same set, new order).',
            parameters: {
                type: 'object',
                properties: {
                    pageId: { type: 'string' },
                    orderedBlockIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['pageId', 'orderedBlockIds'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_set_homepage',
            description: 'Make a page the site\'s homepage (served at "/").',
            parameters: {
                type: 'object',
                properties: { pageId: { type: 'string' } },
                required: ['pageId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_reorder_pages',
            description: 'Reorder the site\'s page list (affects the admin page list and sitemap order — the header menu is separate; edit it with cms_update_header_nav).',
            parameters: {
                type: 'object',
                properties: {
                    orderedIds: { type: 'array', items: { type: 'string' }, description: 'Every page id (pg_…) in the new order.' },
                },
                required: ['orderedIds'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_update_header_nav',
            description: `Replace the public site header's menu. nav REPLACES the entire existing menu WHOLESALE — send every item you want to keep, in render order (max 20). Item: { id?, label, link, children?, dropdown? }; keep the nav_… ids from the draft state for items you keep (ids anchor locale overrides), omit id for new items. children = flat sub-menu of { label, link } (max 10). dropdown = MULTI-COLUMN mega menu { columns:[{ heading, items:[{ label, link, description?, icon?, openInNewTab? }] }] } (max 4 columns × 10 items; a mega item's icon is a Lucide name like ShieldCheck or an uploaded asset url from cms_list_assets; emoji is legacy only) — for a simple flat dropdown use children instead. ${LINK_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    nav: {
                        type: 'array',
                        description: 'The COMPLETE new header menu, in render order — it replaces the whole nav array.',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Existing nav_… id to preserve; omit for new items (one is minted).' },
                                label: { type: 'string', description: 'Visible menu label (non-empty).' },
                                link: { type: 'object', description: 'Link object (see the link union in the tool description).' },
                                children: { type: 'array', description: 'Optional flat sub-menu: { id?, label, link } items (max 10); keep the existing ids so translations stay attached.', items: { type: 'object' } },
                                dropdown: { type: 'object', description: 'Optional multi-column mega menu: { columns:[{ id?, heading, items:[{ id?, label, link }] }] } (max 4 columns × 10 items; keep existing ids). Use children for a flat dropdown.' },
                            },
                            required: ['label', 'link'],
                        },
                    },
                },
                required: ['nav'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cms_update_design',
            description: `Edit the site's THEME: colours, fonts, typography, component shape/size and page layout. This is a DEEP-MERGE PATCH, never a wholesale replace — send ONLY the keys you want to change and every other design value is kept (colorsPatch:{primary} keeps the other six colours). \`preset\` applies one of the built-in themes' complete values FIRST and the other patches then layer on top, so { preset:"midnight-flow", colorsPatch:{primary:"#CE3F26"} } means "that theme, but with this primary". The site LOGO and FAVICON are NOT settable here — they are uploaded assets and you must never invent asset keys. Malformed colours, unknown fonts, out-of-range radius and unknown enum values are REJECTED (nothing is saved), so use the exact vocabulary: ${DESIGN_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    preset: {
                        type: 'string',
                        enum: THEME_PRESET_IDS,
                        description: 'Apply a built-in theme wholesale before the other patches are layered on.',
                    },
                    colorsPatch: {
                        type: 'object',
                        description: `Light-mode colours to change: ${COLOR_KEYS.join(', ')} — each a "#rrggbb" hex string; the roles ${BLANKABLE_COLORS.join(', ')} also accept "" (follow the primary colour).`,
                    },
                    darkColorsPatch: {
                        type: 'object',
                        description: `Dark-mode colours to change: ${DARK_COLOR_KEYS.join(', ')} — each a "#rrggbb" hex string; primary/accent also accept "" (reuse the light value).`,
                    },
                    fontsPatch: {
                        type: 'object',
                        description: 'Font roles to change: { heading?, body?, mono? } — each must be a name from the allowed font library.',
                    },
                    typographyPatch: {
                        type: 'object',
                        description: `Type scale to change: { displaySize? (${DISPLAY_SIZES.join('|')}), headingWeight? (${HEADING_WEIGHTS.join('|')}), displayTracking? (${DISPLAY_TRACKINGS.join('|')}), bodySize? (${BODY_SIZES.join('|')}) }.`,
                    },
                    componentsPatch: {
                        type: 'object',
                        description: `Component shape/size to change — ${enumList(DESIGN_COMPONENT_ENUMS)}.`,
                    },
                    layoutPatch: {
                        type: 'object',
                        description: `Page frame to change — ${enumList(DESIGN_LAYOUT_ENUMS)}.`,
                    },
                    radius: { type: 'number', description: 'Global corner radius in px, 0-24.' },
                    theme: { type: 'string', enum: DESIGN_THEMES, description: 'Which palette the public site renders by default.' },
                    motion: { type: 'string', enum: DESIGN_MOTIONS, description: 'Animation level.' },
                    darkBand: { type: 'string', enum: DARK_BANDS, description: "Fill of blocks with style.band 'dark': the dark-mode background colour (palette) or the theme's secondary colour." },
                    grain: { type: 'boolean', description: 'Subtle film-grain texture overlay.' },
                    gradient: { type: 'boolean', description: 'Gradient treatment on primary surfaces/CTAs.' },
                },
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS, LINK_HINT, DESIGN_HINT };
