/**
 * The Data & links tab as blocks for BlockList: each section a title and a
 * card whose rows are one block each, so a page wired to many things still
 * renders a screenful at a time.
 */

import React, { type ReactElement } from 'react';

import { describeError } from '@/core/api/errors';
import { translate } from '@/core/i18n';
import { cardRows, type Block } from '@/shared/patterns';
import { Banner, Card, Section, Text } from '@/shared/ui';

import { CallRow, GrantRow, TableRow, WritingAutomationRow, type GrantLine } from './DataRows';
import type { DataCards, PageCalls, WebpageGrants } from '../model/audienceTypes';

const block = (key: string, gap: Block['gap'], render: () => ReactElement | null): Block => ({ key, gap, render });

/** A section heading as its own block; `action` sits at its right. */
export function heading(key: string, title: string, subtitle?: string, action?: ReactElement): Block {
    return block(key, 'section', () => (
        <Section title={title} subtitle={subtitle} action={action}>
            {null}
        </Section>
    ));
}

export function note(key: string, text: string): Block {
    return block(key, 'inner', () => (
        <Card>
            <Text variant="body" tone="tertiary">
                {text}
            </Text>
        </Card>
    ));
}

export function failure(key: string, error: unknown): Block {
    return block(key, 'inner', () => <Banner tone="error">{describeError(error).message}</Banner>);
}

/** A section's rows once its query answered, its error if it failed, nothing while it loads. */
export function sectionOf<T>(
    key: string,
    query: { data: T | undefined; isError: boolean; error: unknown },
    build: (data: T) => Block[],
): Block[] {
    if (query.data !== undefined) return build(query.data);
    return query.isError ? [failure(`${key}:error`, query.error)] : [];
}

export function tableBlocks(cards: DataCards): Block[] {
    const blocks = cards.tables.length
        ? cardRows({
              key: 'tables',
              rows: cards.tables,
              rowKey: (r) => r.datatableId,
              render: (r) => <TableRow table={r} />,
          })
        : [note('tables:none', translate('mobile.webpages.data.no_tables', 'This page reads no tables.'))];
    const writers = cards.automations.filter((a) => a.writes);
    if (!writers.length) return blocks;
    return [
        ...blocks,
        heading(
            'writers',
            translate('mobile.webpages.data.writers', 'Automations writing to these tables'),
            translate('mobile.webpages.data.writers_hint', 'They change what the page shows without going through it'),
        ),
        ...cardRows({
            key: 'writers',
            rows: writers,
            rowKey: (a) => a.automationId,
            render: (a) => <WritingAutomationRow automation={a} />,
        }),
    ];
}

export function grantLines(grants: WebpageGrants): GrantLine[] {
    return [
        ...grants.integrations.map((g) => ({
            kind: 'integrations' as const,
            key: g.tool,
            title: g.label ?? g.tool,
            subtitle: g.integrationLabel ?? translate('mobile.webpages.data.integration', 'Integration'),
            available: g.available,
        })),
        ...grants.automations.map((g) => ({
            kind: 'automations' as const,
            key: g.automationId,
            title: g.label ?? g.automationId,
            subtitle: translate('mobile.webpages.data.automation', 'Automation'),
            available: null,
        })),
    ];
}

export function grantBlocks(grants: WebpageGrants, onRevoke: (grant: GrantLine) => void): Block[] {
    const lines = grantLines(grants);
    if (!lines.length) {
        return [
            note(
                'grants:none',
                translate('mobile.webpages.data.no_grants', 'This page may not run any integration or automation.'),
            ),
        ];
    }
    return cardRows({
        key: 'grants',
        rows: lines,
        rowKey: (g) => `${g.kind}:${g.key}`,
        render: (g) => <GrantRow grant={g} onRevoke={onRevoke} />,
    });
}

export function callBlocks(calls: PageCalls): Block[] {
    if (!calls.scanned) {
        return [
            note(
                'calls:unread',
                translate(
                    'mobile.webpages.data.calls_unread',
                    'The page’s code could not be read, so its own calls are unknown.',
                ),
            ),
        ];
    }
    if (!calls.calls.length) {
        return [
            note(
                'calls:none',
                translate('mobile.webpages.data.no_calls', 'The page makes no calls of its own to other sites.'),
            ),
        ];
    }
    return cardRows({
        key: 'calls',
        rows: calls.calls,
        rowKey: (c) => `${c.kind}|${c.method ?? ''}|${c.url}`,
        render: (c) => <CallRow call={c} />,
    });
}
