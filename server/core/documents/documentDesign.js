// @typecheck
'use strict';

const PRESETS = {
    neutral: { accent: '#334155', ink: '#172033', font: 'sans', fontSize: 11, lineHeight: 1.5, margin: 18 },
    branded: { accent: '#d97706', ink: '#172033', font: 'sans', fontSize: 11, lineHeight: 1.6, margin: 18 },
    formal: { accent: '#1e3a5f', ink: '#172033', font: 'serif', fontSize: 12, lineHeight: 1.6, margin: 22 },
};
function designCss(design = {}) {
    const d = { ...PRESETS.neutral, ...PRESETS[design.preset], ...design };
    const color = (v, fallback) => /^#[\da-f]{6}$/i.test(v) ? v : fallback;
    const num = (v, min, max, fallback) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
    const font = d.font === 'serif' ? 'Georgia, serif' : d.font === 'mono' ? 'monospace' : 'Arial, sans-serif';
    return `:root { --doc-accent:${color(d.accent, '#334155')}; --doc-ink:${color(d.ink, '#172033')}; --doc-font:${font}; }
@page { size:${d.pageSize === 'Letter' ? 'Letter' : 'A4'}; margin:${num(d.margin, 0, 40, 18)}mm; }
body { font-family:var(--doc-font); color:var(--doc-ink); font-size:${num(d.fontSize, 8, 24, 11)}pt; line-height:${num(d.lineHeight, 1, 2.5, 1.5)}; }
@media screen { body { width:${d.pageSize === 'Letter' ? '215.9' : '210'}mm; padding:${num(d.margin, 0, 40, 18)}mm; } }
h1,h2,h3 { color:var(--doc-accent); }
.doc-logo { width:${num(d.logoWidth, 10, 80, 24)}mm; margin-left:${d.logoPosition === 'right' ? 'auto' : d.logoPosition === 'center' ? 'auto' : '0'}; margin-right:${d.logoPosition === 'center' ? 'auto' : '0'}; }
.doc-header { display:${d.showHeader === false ? 'none' : 'block'}; }
.doc-footer { display:${d.showFooter === false ? 'none' : 'block'}; }`;
}
module.exports = { PRESETS, designCss };
