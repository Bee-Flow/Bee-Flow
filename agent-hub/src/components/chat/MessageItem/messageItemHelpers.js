import { API_BASE } from '../../../utils/helpers';

/**
 * May the public embed widget show where its answer came from?
 *
 * ── WHY THIS IS A FUNCTION AND NOT `!!config.showSources` ───────────
 * The embed renders on someone else's website, to an audience with no account
 * here. The sources panel behind an answer shows internal document titles,
 * their headings, page numbers, relevance and the FULL retrieved passage —
 * so "did the agent's owner turn this on" has to be answered `false` for every
 * input that is not a deliberate yes. A missing field, a failed fetch, the
 * string "false", a 1 someone stored years ago: all of those are doubt, and
 * doubt renders nothing. Strict `=== true`, nothing coerced.
 *
 * The flag itself is NOT a new setting: it is the agent's existing
 * `includeSourceReferences`, which already gates the same citations
 * server-side. The embed endpoint does not project it yet, so this returns
 * false everywhere today — which is the correct answer until it does.
 */
export const embedSourcesAllowed = (embedConfig) => embedConfig?.showSources === true;

// Resolve server-relative URLs (e.g. /api/storage/file/...) to full server URL
export const resolveUrl = (url) => {
    if (!url) return url;
    if (url.startsWith('/api/')) return `${API_BASE || ''}${url}`;
    return url;
};

// The standalone document written into the print window by the message's
// "Export as PDF" action. Kept verbatim from the original inline template so
// the exported page renders exactly as before.
//
// De titel is het enige stukje tekst hier, en hij komt als ARGUMENT binnen:
// dit is een pure module zonder t() in scope, en de titel staat in de tab van
// het printvenster en boven op de afdruk. Zonder titel valt hij terug op het
// Engels dat hij altijd al had.
export const buildPdfExportHtml = (htmlContent, title = 'AI Response Export') => `<!DOCTYPE html>
<html><head>
    <title>${title}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: white; color: #1a1a1a;
            padding: 48px 40px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.75; font-size: 15px;
            max-width: 800px; margin: 0 auto;
        }
        h1 { font-size: 1.8em; font-weight: 700; margin: 1.2em 0 0.6em; color: #111; }
        h2 { font-size: 1.4em; font-weight: 600; margin: 1.2em 0 0.5em; color: #222; }
        h3 { font-size: 1.15em; font-weight: 600; margin: 1em 0 0.4em; color: #333; }
        h4, h5, h6 { font-size: 1em; font-weight: 600; margin: 0.8em 0 0.3em; color: #444; }
        p { margin: 0.6em 0; }
        ul, ol { margin: 0.5em 0; padding-left: 1.8em; }
        li { margin: 0.25em 0; }
        a { color: #2563eb; text-decoration: underline; }
        strong { font-weight: 600; }
        em { font-style: italic; }
        blockquote {
            border-left: 3px solid #d1d5db; margin: 0.8em 0;
            padding: 0.5em 1em; color: #555; background: #f9fafb;
        }
        pre {
            background: #f3f4f6 !important; color: #1f2937 !important;
            padding: 16px; border-radius: 8px; overflow-x: auto;
            margin: 0.8em 0; border: 1px solid #e5e7eb;
            font-size: 13px; line-height: 1.5;
        }
        code {
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.88em;
        }
        :not(pre) > code {
            background: #f3f4f6; padding: 2px 6px; border-radius: 4px;
            color: #d63384; font-size: 0.85em;
        }
        pre code { background: none !important; padding: 0; color: inherit !important; }
        table {
            border-collapse: collapse; width: 100%; margin: 0.8em 0;
            font-size: 14px;
        }
        th, td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
        th { background: #f3f4f6; font-weight: 600; }
        img { max-width: 100%; height: auto; border-radius: 6px; margin: 0.5em 0; }
        hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
        .hljs, .hljs span { color: #1f2937 !important; }
        .timestamp {
            text-align: right; color: #9ca3af; font-size: 11px;
            margin-top: 40px; border-top: 1px solid #e5e7eb;
            padding-top: 10px;
        }
        /* Hide interactive elements in export */
        button, .copy-btn, [data-copy] { display: none !important; }
        /* Override dark theme code block colors */
        [style*="background: #1e1e2e"], [style*="background:#1e1e2e"] {
            background: #f3f4f6 !important;
            border-color: #e5e7eb !important;
        }
        [style*="color: #94a3b8"] { color: #6b7280 !important; }
        @media print {
            body { padding: 20px !important; }
            pre { white-space: pre-wrap !important; word-break: break-word !important; }
        }
    </style>
</head><body>
    ${htmlContent}
    <div class="timestamp">Exported on ${new Date().toLocaleString()}</div>
</body></html>`;
