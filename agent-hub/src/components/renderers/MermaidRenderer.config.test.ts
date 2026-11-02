/**
 * Diagram source is model output: labels render as SVG text and an `init`
 * directive inside the diagram cannot switch HTML labels or theme CSS back on.
 *
 * Run: cd agent-hub && npx vitest run src/components/renderers/MermaidRenderer.config.test.ts
 */
import { describe, it, expect } from 'vitest';
import mermaid from 'mermaid';
import { MERMAID_CONFIG } from './MermaidRenderer.constants';

describe('MERMAID_CONFIG', () => {
    it('draws labels as SVG text and keeps the label sanitiser strict', () => {
        expect(MERMAID_CONFIG.htmlLabels).toBe(false);
        expect(MERMAID_CONFIG.flowchart?.htmlLabels).toBeUndefined();
        expect(MERMAID_CONFIG.securityLevel).toBe('strict');
        expect(MERMAID_CONFIG.dompurifyConfig?.FORBID_TAGS).toEqual(expect.arrayContaining(['img', 'image', 'style', 'foreignObject']));
    });

    it('a directive in the diagram cannot override the guarded keys', async () => {
        mermaid.initialize(MERMAID_CONFIG);
        const src = '%%{init: {"htmlLabels": true, "themeCSS": "@import url(https://x.example/a.css);", "securityLevel": "loose"}}%%\nflowchart LR\nA-->B';
        await mermaid.parse(src);
        const cfg = mermaid.mermaidAPI.getConfig();
        expect(cfg.htmlLabels).toBe(false);
        expect(String(cfg.themeCSS ?? '')).not.toContain('x.example');
        expect(cfg.securityLevel).toBe('strict');
        expect(cfg.secure).toEqual(expect.arrayContaining(['htmlLabels', 'themeCSS', 'dompurifyConfig']));
    });
});
