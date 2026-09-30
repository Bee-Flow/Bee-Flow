/**
 * Check — everything in this Solution that needs a person, and why publishing
 * is or is not open (the web's SolutionControlPanel).
 *
 * An empty list is what a clean Solution looks like AND what a failed request
 * looks like, so "nothing needs your attention" is said only when the server
 * said `complete: true` — never because there happen to be no findings.
 * Blocking findings come first, where the meaning changes: an error, or one
 * the ladder tagged as blocking publishing.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { cardRows, type Block } from '@/shared/patterns';
import { LoadingState, Text } from '@/shared/ui';

import { FindingRow } from './FindingRow';
import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { useOpenLink } from '../hooks/useOpenLink';
import type { SolutionState } from '../hooks/useSolution';
import { splitFindings } from '../model/checks';
import type { Completeness, Finding } from '../model/solution';
import { sectionNames } from '../model/words';

function group(key: string, title: string, findings: Finding[], onOpen: (link: string) => void): Block[] {
    if (findings.length === 0) return [];
    return [
        block(`${key}:title`, () => <Text variant="subheading">{title}</Text>),
        ...cardRows({
            key,
            rows: findings.map((finding, i) => ({ finding, i })),
            rowKey: ({ finding, i }) => `${finding.code}-${finding.targetRef?.id ?? 'x'}-${i}`,
            render: ({ finding }) => <FindingRow finding={finding} onOpen={onOpen} />,
        }),
    ];
}

/** The blocks for an answer that arrived. */
function checkBlocks(c: Completeness, onOpen: (link: string) => void, t: TranslateFn): Block[] {
    const { blocking, advice } = splitFindings(c.findings);
    const gaps = sectionNames(c.unavailable, t).join(', ');
    const out: Block[] = [];
    if (c.complete === false) {
        out.push(
            block('incomplete', () => (
                <Strip tone="error" detail={gaps || null} testID="solution-control-incomplete">
                    {t('solutions.control_incomplete', 'Part of this Solution could not be read, so this list is not the whole story and publishing stays unavailable.')}
                </Strip>
            )),
        );
    }
    if (c.complete === true && c.findings.length === 0) {
        out.push(
            block('clear', () => (
                <Strip tone="muted" icon="CircleCheck" testID="solution-control-clear">
                    {t('solutions.control_clear', 'Nothing needs your attention. Everything here is wired up and owned consistently.')}
                </Strip>
            )),
        );
    }
    out.push(...group('blocking', t('mobile.projects.control_blocking', 'Has to be fixed first'), blocking, onOpen));
    out.push(...group('advice', t('solutions.status_advice', 'Worth a look'), advice, onOpen));
    if (c.complete === true && blocking.length === 0 && advice.length > 0) {
        out.push(
            block('releasable', () => (
                <Strip tone="muted">
                    {t('solutions.control_releasable', 'None of these stop you publishing — they are things to tidy when you get to them.')}
                </Strip>
            )),
        );
    }
    return out;
}

export function CheckTab({ sol }: { sol: SolutionState }) {
    const t = useTranslation();
    const openLink = useOpenLink();
    const { completeness } = sol;
    if (completeness.isLoading) return <LoadingState />;
    // No answer at all is NOT "nothing to fix": the checks did not run.
    const blocks =
        completeness.isError || !completeness.data
            ? [
                  block('unreachable', () => (
                      <Strip tone="error" testID="solution-control-unreachable">
                          {t('solutions.control_unreachable', 'The checks could not be run just now, so nothing here is confirmed. Publishing stays unavailable until they can.')}
                      </Strip>
                  )),
              ]
            : checkBlocks(completeness.data, openLink, t);
    return <TabBlocks blocks={blocks} onRefresh={() => completeness.refetch()} />;
}
