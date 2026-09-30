/**
 * The web's Mermaid theme (MermaidRenderer.jsx MERMAID_THEME), the colours a
 * flowchart is painted in there whatever the app's theme: dark nodes with an
 * indigo border and light text, slate lines, and a darker panel for a
 * subgraph. mermaidTheme.test.ts reads each value from the web file.
 */

export const MERMAID_THEME = {
    mainBkg: '#2a2a3e',
    nodeBorder: '#6366f1',
    nodeTextColor: '#e2e8f0',
    lineColor: '#94a3b8',
    clusterBkg: '#1e1e2e',
    clusterBorder: '#3a3a4e',
    edgeLabelBackground: '#1e1e2e',
    titleColor: '#e2e8f0',
} as const;

/** The web's flowchart font size and node padding (MERMAID_CONFIG). */
export const MERMAID_FONT_SIZE = 14;
export const MERMAID_NODE_PADDING = 15;
