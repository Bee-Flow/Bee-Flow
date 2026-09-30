/**
 * A fenced block, routed the way the web's CodeRenderer routes it: code to
 * the code block, `workspace` to nothing (the workspace tool shows it), and
 * the rich languages (research, test reports, pages, charts, diagrams, maps)
 * to their native renderers.
 *
 * Two differences from the web, both about a block that is not ready:
 *
 *   - The web shows every rich block as "Building…" while ANY part of the
 *     message streams. Here only a fence that is still open at the tail of a
 *     streaming answer waits; a finished report above it is drawn at once.
 *   - A closed block whose body the renderer cannot read (broken JSON, a
 *     diagram type the phone does not draw) is shown as its code, which can
 *     still be read and copied, rather than as a spinner that never ends.
 */

import React, { type ReactNode } from 'react';

import type { TranslateFn } from '@/core/i18n';

import { useMarkdownEnv } from '../env';
import { BlockLoading } from './BlockLoading';
import { fenceKind, fenceLanguage, isClosedFence, type FenceKind } from '../parse/fences';
import { CodeBlock } from './code/CodeBlock';
import { CompactCode } from './code/CompactCode';
import { isCompactSnippet } from './code/languages';
import { loadChart, loadMermaid, loadPage, loadResearch, loadTestReport } from './lazyModules';
import { MapCard } from './map/MapCard';
import { readMap } from './map/mapModel';

type RichKind = Exclude<FenceKind, 'code' | 'workspace'>;

function loadingLabel(kind: RichKind, t: TranslateFn): string {
    switch (kind) {
        case 'page':
            return t('mobile.markdown.loading_page', 'Creating page…');
        case 'research':
            return t('mobile.markdown.loading_research', 'Building research report…');
        case 'test-report':
            return t('mobile.markdown.loading_test_report', 'Building test report…');
        case 'vega-lite':
            return t('mobile.markdown.loading_chart', 'Rendering chart…');
        case 'mermaid':
            return t('mobile.markdown.loading_diagram', 'Rendering diagram…');
        default:
            return t('mobile.markdown.loading_map', 'Loading map…');
    }
}

/** Each rich renderer, or null when it cannot draw this source. */
const RICH: Record<RichKind, (source: string) => ReactNode | null> = {
    research: (source) => {
        const mod = loadResearch();
        const data = mod?.readResearch(source);
        return mod && data ? <mod.ResearchBlock data={data} /> : null;
    },
    'test-report': (source) => {
        const mod = loadTestReport();
        const data = mod?.readTestReport(source);
        return mod && data ? <mod.TestReportBlock data={data} /> : null;
    },
    page: (source) => {
        const mod = loadPage();
        const data = mod?.readPage(source);
        return mod && data ? <mod.PageBlock page={data} /> : null;
    },
    'vega-lite': (source) => {
        const mod = loadChart();
        const spec = mod?.readChartSource(source);
        return mod && spec ? <mod.ChartBlock spec={spec} /> : null;
    },
    mermaid: (source) => {
        const mod = loadMermaid();
        const chart = mod?.readFlowchart(source);
        return mod && chart ? <mod.MermaidBlock chart={chart} source={source} /> : null;
    },
    map: (source) => {
        const map = readMap(source);
        return map ? <MapCard map={map} /> : null;
    },
};

export function FenceBlock({ raw, info, text, live }: { raw: string; info?: string; text: string; live: boolean }) {
    const { t } = useMarkdownEnv();
    const language = fenceLanguage(info);
    const kind = fenceKind(language);
    if (kind === 'workspace') return null;
    if (kind !== 'code') {
        if (live && !isClosedFence(raw)) return <BlockLoading label={loadingLabel(kind, t)} />;
        const rich = RICH[kind](text);
        if (rich) return <>{rich}</>;
    }
    if (isCompactSnippet(text, language)) return <CompactCode code={text} />;
    return <CodeBlock code={text} language={language} />;
}
