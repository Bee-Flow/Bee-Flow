import type React from 'react';

/**
 * ResearchRenderer — Renders structured deep research reports.
 * Triggered when a message contains a ```json-research code block.
 *
 * ═══════════════════════════════════════════════════════════════
 *  AGENT INSTRUCTIONS — Structured Research Output Format
 * ═══════════════════════════════════════════════════════════════
 *
 * To produce a rich visual report, output a fenced code block with
 * the language tag `json-research` containing a JSON object:
 *
 *   ```json-research
 *   { "title": "...", "blocks": [ ... ] }
 *   ```
 *
 * ── Root Object ──────────────────────────────────────────────
 *   title   (string)  Report title (shown if no hero block)
 *   blocks  (array)   Ordered list of block objects (see below)
 *
 * ── Block Types ──────────────────────────────────────────────
 *
 *  hero       Title banner with optional background image.
 *             Fields: title, subtitle?, image? (URL), date?
 *
 *  markdown   Rich text content (full Markdown supported).
 *  | text     Fields: content (Markdown string)
 *
 *  image      Standalone image with optional caption.
 *             Fields: src|url, alt?, caption?, credit?, height?, fit?
 *
 *  sources    Collapsible list of reference links.
 *             Fields: items[] → { url, title? }
 *
 *  callout    Highlighted info/warning/tip/success box.
 *             Fields: variant ("info"|"warning"|"success"|"tip"),
 *                     title?, content (text)
 *
 *  stats      Row of key metric cards (max 4 columns).
 *             Fields: items[] → { value, label, color? (CSS gradient) }
 *
 *  columns    Multi-column layout (max 3). Nests child blocks.
 *             Fields: columns? (number), children[] (block objects)
 *
 *  section    Titled wrapper that groups child blocks.
 *             Fields: title, children[]|blocks[] (block objects)
 *
 *  divider    Horizontal rule separator. No fields needed.
 *
 * ── Full Example ─────────────────────────────────────────────
 *
 *   ```json-research
 *   {
 *     "title": "AI in Healthcare: Risks & Opportunities",
 *     "blocks": [
 *       { "type": "hero", "title": "AI in Healthcare", "subtitle": "A comprehensive analysis", "date": "February 2026" },
 *       { "type": "stats", "items": [
 *         { "value": "78%", "label": "Adoption Rate" },
 *         { "value": "$45B", "label": "Market Size" },
 *         { "value": "2.3x", "label": "Efficiency Gain" }
 *       ]},
 *       { "type": "section", "title": "Key Findings", "children": [
 *         { "type": "markdown", "content": "## Diagnostic Accuracy\nAI models now match specialist-level accuracy in **radiology** and **pathology**." },
 *         { "type": "callout", "variant": "warning", "title": "Bias Risk", "content": "Training data imbalances can lead to misdiagnosis in underrepresented populations." }
 *       ]},
 *       { "type": "columns", "children": [
 *         { "type": "callout", "variant": "success", "title": "Benefits", "content": "Faster diagnosis, reduced costs, 24/7 availability" },
 *         { "type": "callout", "variant": "warning", "title": "Risks", "content": "Data privacy, algorithmic bias, over-reliance" }
 *       ]},
 *       { "type": "divider" },
 *       { "type": "sources", "items": [
 *         { "url": "https://example.com/study", "title": "WHO AI Health Report 2025" }
 *       ]}
 *     ]
 *   }
 *   ```
 *
 * ── Guidelines ───────────────────────────────────────────────
 *  • Start with a hero block for visual impact.
 *  • Use stats early to surface key numbers.
 *  • Group related content under section blocks.
 *  • Use callouts sparingly for warnings, tips, and highlights.
 *  • Always include a sources block at the end with reference URLs.
 *  • Use divider blocks between major sections for readability.
 *  • The markdown block supports full Markdown: headers, lists,
 *    bold, italic, code, tables, and links.
 *  • Keep the JSON valid — no trailing commas, no comments.
 * ═══════════════════════════════════════════════════════════════
 */
export interface ResearchItem {
    url: string;
    title?: string;
    value?: string;
    label?: string;
    color?: string;
}

export interface ResearchBlock {
    type?: string;
    id?: string;
    title?: string;
    subtitle?: string;
    image?: string;
    date?: string;
    content?: string;
    text?: string;
    src?: string;
    url?: string;
    alt?: string;
    caption?: string;
    credit?: string;
    height?: string | number;
    fit?: React.CSSProperties['objectFit'];
    items?: ResearchItem[];
    variant?: string;
    columns?: number;
    gap?: string;
    children?: ResearchBlock[];
    blocks?: ResearchBlock[];
}

export interface ResearchData {
    title?: string;
    blocks?: ResearchBlock[];
}
