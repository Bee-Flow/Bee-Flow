/**
 * The rows of the Data & links tab: a bound table, an automation writing to
 * one, a bridge grant (with its revoke), and a call the page makes from its
 * own code. Each is a ListRow slice of its section's card.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, IconButton, ListRow } from '@/shared/ui';

import type { DataCardAutomation, DataCardTable, PageCall } from '../model/audienceTypes';

export function TableRow({ table }: { table: DataCardTable }) {
    const t = useTranslation();
    const facts = [
        table.mode === 'readwrite'
            ? t('mobile.webpages.data.reads_writes', 'Reads and writes')
            : t('mobile.webpages.data.reads', 'Reads'),
        table.rowCount !== null ? t('mobile.webpages.data.rows', '{count} rows', { count: table.rowCount }) : null,
        table.publicColumns.length
            ? t('mobile.webpages.data.public_columns', '{count} public columns', { count: table.publicColumns.length })
            : null,
    ].filter(Boolean);
    return (
        <ListRow
            title={
                table.missing
                    ? t('mobile.webpages.data.table_missing', 'A table you can no longer open')
                    : (table.name ?? table.datatableId)
            }
            subtitle={facts.join(' · ')}
            trailing={
                table.usedInCode === false ? (
                    <Badge label={t('mobile.webpages.data.unused', 'Not used in code')} tone="warning" />
                ) : undefined
            }
        />
    );
}

export function WritingAutomationRow({ automation }: { automation: DataCardAutomation }) {
    const t = useTranslation();
    return (
        <ListRow
            title={automation.title ?? automation.automationId}
            subtitle={t('mobile.webpages.data.writes_to', 'Writes to {table} directly', {
                table: automation.tableName ?? t('mobile.webpages.data.a_table', 'a table'),
            })}
            trailing={<Badge label={t('mobile.webpages.data.writes', 'Writes')} tone="warning" />}
        />
    );
}

export interface GrantLine {
    kind: 'integrations' | 'automations';
    key: string;
    title: string;
    subtitle: string;
    /** True connected, false needs reconnecting, null unknown or not applicable. */
    available: boolean | null;
}

export function GrantRow({ grant, onRevoke }: { grant: GrantLine; onRevoke?: (grant: GrantLine) => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const needsReconnect = grant.kind === 'integrations' && grant.available === false;
    return (
        <ListRow
            title={grant.title}
            subtitle={needsReconnect ? t('mobile.webpages.data.reconnect', 'Needs reconnect') : grant.subtitle}
            leading={
                <Icon
                    name={grant.kind === 'automations' ? 'Workflow' : 'Plug'}
                    size={18}
                    color={theme.colors.textSecondary}
                />
            }
            trailing={
                onRevoke ? (
                    <IconButton
                        icon={<Icon name="Trash2" size={18} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('mobile.webpages.data.revoke', 'Remove {name}', { name: grant.title })}
                        onPress={() => onRevoke(grant)}
                    />
                ) : undefined
            }
        />
    );
}

export function CallRow({ call }: { call: PageCall }) {
    const where = call.line !== null ? `${call.source}:${call.line}` : call.source;
    const how = call.kind === 'xhr' ? 'XMLHttpRequest' : 'fetch()';
    const facts = [where, how, call.method, call.occurrences > 1 ? `×${call.occurrences}` : null].filter(Boolean);
    return <ListRow title={call.host || call.url} subtitle={`${call.url}\n${facts.join(' · ')}`} wrapTitle />;
}
