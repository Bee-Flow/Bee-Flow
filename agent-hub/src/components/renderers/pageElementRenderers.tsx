import type { ReactNode } from 'react';
import { isPageElement, type PageElementRenderer, type PageRenderContext } from './pageElementTypes';
import {
    renderCard, renderDivider, renderGrid, renderHeading, renderImage, renderList,
    renderPage, renderRow, renderSection, renderText
} from './pageLayoutElements';
import {
    renderAccordion, renderBadge, renderButton, renderChart, renderStat, renderTable, renderTabs
} from './pageDataElements';

const RENDERERS: Record<string, PageElementRenderer> = {
    // layout
    page: renderPage,
    grid: renderGrid,
    row: renderRow,
    columns: renderRow,
    section: renderSection,
    card: renderCard,
    // content
    heading: renderHeading,
    text: renderText,
    paragraph: renderText,
    image: renderImage,
    list: renderList,
    divider: renderDivider,
    // interactive
    button: renderButton,
    tabs: renderTabs,
    accordion: renderAccordion,
    // data
    table: renderTable,
    stat: renderStat,
    badge: renderBadge,
    chart: renderChart
};

/** Render one page element (recursively, through `ctx.renderElement`). */
export function renderPageElement(element: unknown, index: number, ctx: PageRenderContext): ReactNode {
    if (!element || !isPageElement(element)) return null;

    const key = element.id || `el-${index}`;
    const renderer = typeof element.type === 'string' && Object.hasOwn(RENDERERS, element.type) ? RENDERERS[element.type] : undefined;
    if (renderer) return renderer(element, key, ctx);

    if (element.text || element.content) {
        return (
            <div key={key} style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                {element.text || element.content}
            </div>
        );
    }
    return null;
}
