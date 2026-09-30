/**
 * Flow — how the pieces of this Solution are wired (the web's ProjectFlowTab),
 * as a grouped list: problems first, in words; then each thing that calls
 * something, with what it calls under it; then what it depends on outside.
 *
 * Reassurance is gated on `complete === true` and nothing else. A graph drawn
 * from four of six kinds is true about those four, and the routine with the
 * cross-owner edge may be sitting in the half that did not load.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { cardRows, type Block } from '@/shared/patterns';
import { LoadingState, Text } from '@/shared/ui';

import { FindingRow } from './FindingRow';
import { EdgeRow, ExternalRow, NodeTitle } from './FlowRows';
import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { useProjectGraph } from '../hooks/solutionQueries';
import { wiringGroups } from '../model/graph';
import type { SolutionGraph } from '../model/solution';
import { sectionNames } from '../model/words';

const heading = (key: string, text: string) => block(key, () => <Text variant="subheading">{text}</Text>);
const note = (key: string, text: string) => block(key, () => <Strip tone="quiet">{text}</Strip>, 'inner');

function verdictBlocks(graph: SolutionGraph, t: TranslateFn): Block[] {
    if (graph.complete === false) {
        const gaps = sectionNames(graph.unavailable, t).join(', ');
        return [
            block('incomplete', () => (
                <Strip tone="warning" detail={gaps || null} testID="project-flow-incomplete">
                    {t('projects.flow_incomplete', 'Part of this project could not be read, so what is drawn here is not the whole picture.')}
                </Strip>
            )),
        ];
    }
    if (graph.complete === null) {
        return [
            block('unverified', () => (
                <Strip tone="muted">
                    {t('projects.flow_completeness_unknown', 'This view could not confirm it read the whole project, so treat it as partial.')}
                </Strip>
            )),
        ];
    }
    return [];
}

function wiringBlocks(graph: SolutionGraph, whole: boolean, t: TranslateFn): Block[] {
    const groups = wiringGroups(graph);
    if (groups.length === 0) {
        return [
            note(
                'wiring:none',
                whole
                    ? t('projects.flow_nothing_wired', 'Nothing in this project calls anything else yet.')
                    : t('projects.flow_nothing_wired_partial', 'Nothing that could be read calls anything else.'),
            ),
        ];
    }
    return groups.flatMap((g) => [
        block(`from:${g.fromId}`, () => <NodeTitle node={g.from} fallback={g.fromId} />, 'inner'),
        ...cardRows({
            key: `edges:${g.fromId}`,
            rows: g.edges.map((e, i) => ({ ...e, i })),
            rowKey: ({ edge, i }) => `${edge.to ?? 'none'}-${i}`,
            render: ({ edge, target }) => <EdgeRow edge={edge} target={target} />,
            gap: 'none',
        }),
    ]);
}

function flowBlocks(graph: SolutionGraph, onOpen: (link: string) => void, t: TranslateFn): Block[] {
    const whole = graph.complete === true;
    const problems: Block[] =
        graph.problems.length === 0
            ? [
                  note(
                      'problems:none',
                      whole
                          ? t('projects.flow_all_connected', 'Everything in this project is connected and owned consistently.')
                          : t('projects.flow_no_problems_partial', 'Nothing was wrong in the parts that could be read.'),
                  ),
              ]
            : cardRows({
                  key: 'problems',
                  rows: graph.problems.map((p, i) => ({ p, i })),
                  rowKey: ({ p, i }) => `${p.code}-${p.from ?? ''}-${i}`,
                  render: ({ p }) => <FindingRow finding={p} onOpen={onOpen} />,
              });
    const externals: Block[] = graph.externals.length
        ? [
              heading('externals', t('projects.flow_externals', 'Depends on things outside this project')),
              ...cardRows({ key: 'ext', rows: graph.externals, rowKey: (e) => `${e.kind}:${e.id}`, render: (e) => <ExternalRow external={e} /> }),
          ]
        : [];
    return [
        ...verdictBlocks(graph, t),
        heading('health', t('projects.flow_health', 'Health')),
        ...problems,
        heading('wiring', t('projects.flow_wiring', 'How it fits together')),
        ...wiringBlocks(graph, whole, t),
        ...externals,
    ];
}

export function FlowTab({ id, onOpen }: { id: string; onOpen: (link: string) => void }) {
    const t = useTranslation();
    const graph = useProjectGraph(id);
    if (graph.isLoading) return <LoadingState />;
    const blocks = graph.data
        ? flowBlocks(graph.data, onOpen, t)
        : [
              block('unavailable', () => (
                  <Strip tone="warning">{t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}</Strip>
              )),
          ];
    return <TabBlocks blocks={blocks} onRefresh={() => graph.refetch()} />;
}
