/* ── SVG Post-Processing ──────────────────────────────── */
export function postProcessSVG(svgElement: SVGSVGElement) {
    if (!svgElement) return;

    // Style: max-width responsive
    svgElement.style.maxWidth = '100%';
    svgElement.style.height = 'auto';

    // Add drop-shadow filter definition to SVG
    let defs = svgElement.querySelector('defs');
    if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svgElement.prepend(defs);
    }

    // Premium drop-shadow filter
    if (!defs.querySelector('#premium-shadow')) {
        const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', 'premium-shadow');
        filter.setAttribute('x', '-10%');
        filter.setAttribute('y', '-10%');
        filter.setAttribute('width', '130%');
        filter.setAttribute('height', '140%');
        filter.innerHTML = `
            <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(59, 130, 246, 0.15)" flood-opacity="1"/>
        `;
        defs.appendChild(filter);
    }

    // Subtle glow filter for highlighted elements
    if (!defs.querySelector('#node-glow')) {
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        glow.setAttribute('id', 'node-glow');
        glow.setAttribute('x', '-20%');
        glow.setAttribute('y', '-20%');
        glow.setAttribute('width', '150%');
        glow.setAttribute('height', '150%');
        glow.innerHTML = `
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feMerge>
                <feMergeNode in="blur"/>
                <feMergeNode in="SourceGraphic"/>
            </feMerge>
        `;
        defs.appendChild(glow);
    }

    // Apply shadows and rounded corners to nodes
    const nodeRects = svgElement.querySelectorAll<SVGElement>('.node rect, .node polygon, .node circle, .node ellipse');
    nodeRects.forEach(el => {
        el.style.filter = 'url(#premium-shadow)';
        if (el.tagName === 'rect') {
            // Soft rounded corners
            if (!el.getAttribute('rx') || parseFloat(el.getAttribute('rx') as string) < 6) {
                el.setAttribute('rx', '8');
                el.setAttribute('ry', '8');
            }
        }
    });

    // Style cluster/subgraph backgrounds
    const clusterRects = svgElement.querySelectorAll<SVGElement>('.cluster rect');
    clusterRects.forEach(el => {
        el.setAttribute('rx', '12');
        el.setAttribute('ry', '12');
        el.style.filter = 'url(#premium-shadow)';
    });

    // Thicker, smoother edge lines
    const edges = svgElement.querySelectorAll('.edge-pattern, .flowchart-link, path.path');
    edges.forEach(el => {
        const currentStrokeWidth = el.getAttribute('stroke-width');
        if (!currentStrokeWidth || parseFloat(currentStrokeWidth) < 1.8) {
            el.setAttribute('stroke-width', '1.8');
        }
    });

    // Better arrowhead markers
    const markers = svgElement.querySelectorAll<SVGElement>('marker polygon, marker path');
    markers.forEach(el => {
        if (!el.style.fill || el.style.fill === '#333') {
            el.style.fill = '#3b82f6';
        }
    });

    // Enhance edge labels
    const edgeLabels = svgElement.querySelectorAll('.edgeLabel rect, .labelBkg');
    edgeLabels.forEach(el => {
        el.setAttribute('rx', '6');
        el.setAttribute('ry', '6');
    });

    // Actor styling for sequence diagrams
    const actors = svgElement.querySelectorAll<SVGElement>('.actor');
    actors.forEach(el => {
        if (el.tagName === 'rect') {
            el.setAttribute('rx', '10');
            el.setAttribute('ry', '10');
            el.style.filter = 'url(#premium-shadow)';
        }
    });

    // Note styling for sequence diagrams
    const notes = svgElement.querySelectorAll('.note rect');
    notes.forEach(el => {
        el.setAttribute('rx', '8');
        el.setAttribute('ry', '8');
    });
}
