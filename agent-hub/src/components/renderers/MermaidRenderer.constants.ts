import { type MermaidConfig } from 'mermaid';

const MERMAID_THEME = {
    darkMode: true,
    background: '#1e1e2e',
    primaryColor: '#818cf8',
    primaryTextColor: '#e2e8f0',
    primaryBorderColor: '#6366f1',
    secondaryColor: '#a78bfa',
    secondaryTextColor: '#e2e8f0',
    secondaryBorderColor: '#7c3aed',
    tertiaryColor: '#2a2a3e',
    tertiaryTextColor: '#e2e8f0',
    tertiaryBorderColor: '#3a3a4e',
    lineColor: '#94a3b8',
    textColor: '#e2e8f0',
    mainBkg: '#2a2a3e',
    nodeBorder: '#6366f1',
    clusterBkg: '#1e1e2e',
    clusterBorder: '#3a3a4e',
    titleColor: '#e2e8f0',
    edgeLabelBackground: '#1e1e2e',
    nodeTextColor: '#e2e8f0',
    // Gantt-specific
    sectionBkgColor: '#2a2a3e',
    altSectionBkgColor: '#1e1e2e',
    sectionBkgColor2: '#3a3a4e',
    gridColor: '#3a3a4e',
    doneTaskBkgColor: '#818cf8',
    doneTaskBorderColor: '#6366f1',
    activeTaskBkgColor: '#a78bfa',
    activeTaskBorderColor: '#7c3aed',
    taskBkgColor: '#4a4a6e',
    taskBorderColor: '#6366f1',
    taskTextColor: '#e2e8f0',
    taskTextOutsideColor: '#e2e8f0',
    taskTextDarkColor: '#e2e8f0',
    todayLineColor: '#f472b6',
};

/**
 * Diagram source comes from model output. Labels are drawn as SVG text, not
 * HTML, so a label cannot carry an element that loads from another host; the
 * keys that would undo that (and the free-form theme CSS) cannot be set from
 * an `init` directive or front matter inside the diagram.
 */
const MERMAID_SECURE_KEYS = [
    'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
    'htmlLabels', 'themeCSS', 'dompurifyConfig',
];

export const MERMAID_CONFIG: MermaidConfig & { gantt?: { sidePadding?: number } } = {
    startOnLoad: false,
    securityLevel: 'strict',
    secure: MERMAID_SECURE_KEYS,
    htmlLabels: false,
    dompurifyConfig: {
        FORBID_TAGS: ['style', 'img', 'image', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'link', 'foreignObject'],
        FORBID_ATTR: ['style', 'src', 'srcset', 'background', 'poster'],
    },
    theme: 'dark',
    themeVariables: MERMAID_THEME,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 14,
    flowchart: { curve: 'basis', padding: 15 },
    gantt: {
        titleTopMargin: 15, barHeight: 24, barGap: 6,
        topPadding: 40, sidePadding: 60, numberSectionStyles: 4,
    },
    sequence: {
        diagramMarginX: 20, diagramMarginY: 20,
        actorMargin: 60, messageMargin: 40,
    },
};
