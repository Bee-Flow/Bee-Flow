import type { MermaidConfig } from 'mermaid';
import { MERMAID_SAFE_OPTIONS } from '@/components/renderers/MermaidRenderer.constants';

/* ── Premium Theme Configuration ──────────────────────── */
export const MERMAID_CONFIG: MermaidConfig = {
    // Diagram source can arrive from an ingested document, a colleague or an AI
    // write, and mermaid's output is rendered with innerHTML: the same strict
    // options as the chat's diagrams (labels as SVG text, a label sanitiser
    // without images or styles, and keys a directive in the diagram cannot
    // change).
    ...MERMAID_SAFE_OPTIONS,
    theme: 'base',
    themeVariables: {
        darkMode: false,
        background: '#ffffff',
        // Core palette — calm blue-teal (Studio-aligned)
        primaryColor: '#eff6ff',
        primaryTextColor: '#1e3a8a',
        primaryBorderColor: '#3b82f6',

        secondaryColor: '#ecfdf5',
        secondaryTextColor: '#064e3b',
        secondaryBorderColor: '#34d399',

        tertiaryColor: '#f0fdf4',
        tertiaryTextColor: '#14532d',
        tertiaryBorderColor: '#86efac',

        // Edges & labels
        lineColor: '#3b82f6',
        textColor: '#1e293b',
        edgeLabelBackground: '#ffffff',

        // Flowchart nodes
        mainBkg: '#eff6ff',
        nodeBorder: '#3b82f6',
        nodeTextColor: '#1e3a8a',

        // Clusters / subgraphs
        clusterBkg: '#f0f9ff',
        clusterBorder: '#7dd3fc',

        // Title
        titleColor: '#1e3a8a',

        // Sequence diagram
        actorTextColor: '#1e3a8a',
        actorBorder: '#3b82f6',
        actorBkg: '#eff6ff',
        signalColor: '#1d4ed8',
        labelBoxBkgColor: '#eff6ff',

        // Notes
        noteBkgColor: '#fffbeb',
        noteTextColor: '#78350f',
        noteBorderColor: '#f59e0b',

        // Misc
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        fontSize: '15px',
    },
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: 15,
    flowchart: {
        curve: 'basis',
        padding: 18,
        nodeSpacing: 50,
        rankSpacing: 60,
        diagramPadding: 16,
    },
    sequence: {
        diagramMarginX: 20,
        diagramMarginY: 16,
        actorMargin: 60,
        messageMargin: 40,
        boxMargin: 8,
        boxTextMargin: 6,
        noteMargin: 12,
        mirrorActors: false,
    },
    mindmap: { padding: 20 },
    gantt: { fontSize: 13 },
};
