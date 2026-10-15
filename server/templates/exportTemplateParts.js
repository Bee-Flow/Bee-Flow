/**
 * The static parts of the PDF export document (exportTemplate.js): the print
 * stylesheet and the fallback script for diagrams that arrive un-rendered.
 */

const EXPORT_CSS = `    /* ── Print page setup ────────────────────────────── */
    @page {
        size: letter;
        margin: 0.75in 0.85in 0.9in 0.85in;
    }
    @page :first { margin-top: 0; }

    /* ── Base typography ─────────────────────────────── */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 10.5pt;
        line-height: 1.7;
        color: #1e293b;
        background: white;
        max-width: 100%;
        -webkit-font-smoothing: antialiased;
    }

    /* ── Cover page ──────────────────────────────────── */
    .cover-page {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        min-height: 100vh;
        padding: 0 0 2.5in 0;
        page-break-after: always;
        position: relative;
    }

    /* Top accent strip */
    .cover-page::before {
        content: '';
        position: absolute;
        top: 0;
        left: -0.85in;
        right: -0.85in;
        height: 6px;
        background: linear-gradient(90deg, #4f46e5, #7c3aed, #6366f1);
    }

    .cover-title {
        font-size: 32pt;
        font-weight: 700;
        color: #0f172a;
        line-height: 1.15;
        margin-bottom: 16pt;
        max-width: 5.5in;
        letter-spacing: -0.02em;
    }

    .cover-divider {
        width: 48px;
        height: 3px;
        background: linear-gradient(90deg, #4f46e5, #818cf8);
        border-radius: 2px;
        margin-bottom: 14pt;
    }

    .cover-meta {
        font-size: 10.5pt;
        color: #64748b;
        line-height: 1.8;
    }
    .cover-meta .meta-label {
        font-weight: 600;
        color: #475569;
        display: inline-block;
        min-width: 60pt;
    }

    .cover-branding {
        position: absolute;
        bottom: 0.75in;
        left: 0;
        display: flex;
        align-items: center;
        gap: 6pt;
        font-size: 9pt;
        color: #94a3b8;
        letter-spacing: 0.03em;
    }
    .cover-branding .bee-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18pt;
        height: 18pt;
        background: linear-gradient(135deg, #eef2ff, #e0e7ff);
        border-radius: 5pt;
        font-size: 10pt;
    }
    .cover-branding .bee-logo {
        height: 20pt;
        width: auto;
        object-fit: contain;
    }

    /* ── Document content ────────────────────────────── */
    .document-body {
        padding-top: 8pt;
    }
    .document-body p {
        margin-bottom: 8pt;
        orphans: 3;
        widows: 3;
    }

    /* ── Headings ── */
    .document-body h1 {
        font-size: 20pt;
        font-weight: 700;
        color: #0f172a;
        margin-top: 28pt;
        margin-bottom: 10pt;
        page-break-after: avoid;
        padding-bottom: 6pt;
        border-bottom: 1.5pt solid #e2e8f0;
        letter-spacing: -0.01em;
    }
    .document-body h2 {
        font-size: 15pt;
        font-weight: 600;
        color: #1e293b;
        margin-top: 22pt;
        margin-bottom: 8pt;
        page-break-after: avoid;
        padding-left: 10pt;
        border-left: 3pt solid #6366f1;
    }
    .document-body h3 {
        font-size: 12.5pt;
        font-weight: 600;
        color: #334155;
        margin-top: 16pt;
        margin-bottom: 6pt;
        page-break-after: avoid;
    }
    .document-body h4, .document-body h5, .document-body h6 {
        font-size: 11pt;
        font-weight: 600;
        color: #475569;
        margin-top: 12pt;
        margin-bottom: 4pt;
        page-break-after: avoid;
    }

    /* ── Lists ── */
    .document-body ul, .document-body ol {
        margin-left: 0.25in;
        margin-bottom: 8pt;
        padding-left: 0;
    }
    .document-body li {
        margin-bottom: 3pt;
        page-break-inside: avoid;
    }
    .document-body li p { margin-bottom: 2pt; }

    /* Task lists */
    .document-body ul[data-type="taskList"] {
        list-style: none;
        margin-left: 0;
    }
    .document-body li[data-checked="true"]::before { content: "☑ "; color: #4f46e5; }
    .document-body li[data-checked="false"]::before { content: "☐ "; color: #94a3b8; }

    /* ── Links ── */
    .document-body a {
        color: #4f46e5;
        text-decoration: none;
    }

    /* ── Bold / italic ── */
    .document-body strong { font-weight: 600; }
    .document-body em { font-style: italic; }

    /* ── Blockquotes ── */
    .document-body blockquote {
        border-left: 3pt solid #818cf8;
        margin: 12pt 0;
        padding: 10pt 16pt;
        background: #f8fafc;
        color: #334155;
        border-radius: 0 6pt 6pt 0;
        page-break-inside: avoid;
    }
    .document-body blockquote p { margin-bottom: 4pt; }

    /* ── Code (inline) ── */
    .document-body code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 9pt;
        background: #f1f5f9;
        padding: 1.5pt 5pt;
        border-radius: 3pt;
        color: #6366f1;
        border: 0.5pt solid #e2e8f0;
    }

    /* ── Code blocks ── */
    .document-body pre {
        background: #1e1e2e;
        color: #cdd6f4;
        padding: 14pt 18pt;
        border-radius: 8pt;
        margin: 14pt 0;
        overflow-x: auto;
        font-size: 8.5pt;
        line-height: 1.55;
        page-break-inside: avoid;
        border: 0.5pt solid #313244;
    }
    .document-body pre code {
        background: none;
        padding: 0;
        color: inherit;
        font-size: inherit;
        border: none;
    }

    /* ── Tables ── */
    .document-body table {
        width: 100%;
        border-collapse: collapse;
        margin: 14pt 0;
        font-size: 9.5pt;
        page-break-inside: avoid;
    }
    .document-body th {
        background: #eef2ff;
        font-weight: 600;
        text-align: left;
        padding: 7pt 10pt;
        border: 0.5pt solid #c7d2fe;
        color: #312e81;
        font-size: 9pt;
        text-transform: uppercase;
        letter-spacing: 0.03em;
    }
    .document-body td {
        padding: 6pt 10pt;
        border: 0.5pt solid #e2e8f0;
        vertical-align: top;
        color: #334155;
    }
    .document-body tr:nth-child(even) td { background: #f8fafc; }

    /* ── Images ── */
    .document-body img {
        max-width: 100%;
        height: auto;
        border-radius: 6pt;
        margin: 10pt 0;
        page-break-inside: avoid;
    }

    /* ── Horizontal rule ── */
    .document-body hr {
        border: none;
        height: 1.5pt;
        background: linear-gradient(90deg, #e2e8f0, #c7d2fe, #e2e8f0);
        margin: 20pt 0;
        border-radius: 1pt;
    }

    /* ── Mark / highlight ── */
    .document-body mark {
        background: #fef08a;
        padding: 0 3pt;
        border-radius: 2pt;
    }

    /* ── Preserve inline styles from TipTap ── */
    .document-body [style*="color"] { }
    .document-body [style*="font-family"] { }

    /* ── Diagram containers (mermaid fallback renders) ── */
    .document-body .mermaid-export-wrapper {
        text-align: center;
        margin: 16pt 0;
        page-break-inside: avoid;
    }
    .document-body .mermaid-export-wrapper svg {
        max-width: 100%;
        height: auto;
    }`;

const EXPORT_MERMAID_FALLBACK_SCRIPT = `    (() => {
        try {
            document.querySelectorAll('div[data-type="mermaid-diagram"]').forEach((div) => {
                const rawCode = div.getAttribute('data-code') || div.textContent || '';
                if (!rawCode.trim()) return;
                let code;
                try {
                    code = decodeURIComponent(escape(atob(rawCode)));
                } catch {
                    code = rawCode.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
                }
                const fallback = document.createElement('pre');
                fallback.style.cssText = 'background:#f1f5f9;padding:12px;border-radius:6px;font-size:10pt;color:#334155;border:1px solid #e2e8f0;white-space:pre-wrap;';
                fallback.textContent = code.trim();
                div.replaceWith(fallback);
            });
        } catch (e) { console.error('Mermaid fallback failed:', e); }
    })();`;

module.exports = { EXPORT_CSS, EXPORT_MERMAID_FALLBACK_SCRIPT };
