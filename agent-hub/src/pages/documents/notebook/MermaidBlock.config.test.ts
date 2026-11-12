/**
 * Notebook and document-editor diagrams (MermaidBlock, and MermaidView which
 * reuses it) render with the same strict options as the chat's: labels as SVG
 * text, a label sanitiser without images or styles, and an `init` directive in
 * the diagram cannot switch any of that back.
 *
 * Run: cd agent-hub && npx vitest run src/pages/documents/notebook/MermaidBlock.config.test.ts
 */
import { describe, it, expect } from 'vitest';
import mermaid from 'mermaid';
import { MERMAID_CONFIG } from './MermaidBlock.constants';
import { MERMAID_SAFE_OPTIONS } from '@/components/renderers/MermaidRenderer.constants';

describe('notebook MERMAID_CONFIG', () => {
    it('carries every shared safe option unchanged', () => {
        for (const [key, value] of Object.entries(MERMAID_SAFE_OPTIONS)) {
            expect(MERMAID_CONFIG[key as keyof typeof MERMAID_CONFIG], key).toEqual(value);
        }
    });

    it('draws labels as SVG text, also for flowcharts', () => {
        expect(MERMAID_CONFIG.htmlLabels).toBe(false);
        expect(MERMAID_CONFIG.flowchart?.htmlLabels).toBeUndefined();
        expect(MERMAID_CONFIG.securityLevel).toBe('strict');
        expect(MERMAID_CONFIG.dompurifyConfig?.FORBID_TAGS).toEqual(expect.arrayContaining(['img', 'image', 'style', 'foreignObject']));
        expect(MERMAID_CONFIG.dompurifyConfig?.FORBID_ATTR).toEqual(expect.arrayContaining(['src', 'srcset', 'style']));
    });

    it('a directive in the diagram cannot override the guarded keys', async () => {
        mermaid.initialize(MERMAID_CONFIG);
        const src = '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": "@import url(https://x.example/a.css);", "securityLevel": "loose"}}%%\nflowchart LR\nA["<img src=https://x.example/p.png>"]-->B';
        await mermaid.parse(src);
        const cfg = mermaid.mermaidAPI.getConfig();
        expect(cfg.htmlLabels).toBe(false);
        expect(cfg.flowchart?.htmlLabels).not.toBe(true);
        expect(String(cfg.themeCSS ?? '')).not.toContain('x.example');
        expect(cfg.securityLevel).toBe('strict');
    });
});
