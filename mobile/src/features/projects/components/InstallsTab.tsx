/**
 * Installs — how often this Solution was installed, and why that number is
 * not a total (the web's SolutionInstallsTab). Two numbers, nothing else: no
 * project names, no organisations, no dates.
 *
 * The count is a LOWER BOUND by definition (only this instance, only installs
 * that could be tied back to this Blueprint), so the sentence saying so is
 * always there when a number is. Either half can be unknown on its own, and
 * unknown is never shown as 0.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { LoadingState, Text } from '@/shared/ui';

import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { useInstallCounts } from '../hooks/solutionQueries';
import { byCount } from '../model/words';

export function InstallsTab({ id }: { id: string }) {
    const t = useTranslation();
    const installs = useInstallCounts(id, true);
    if (installs.isLoading) return <LoadingState />;

    const counts = installs.isError ? null : installs.data;
    if (!counts) {
        const blocks = [
            block('unknown', () => (
                <Strip tone="error" testID="installs-unreadable">
                    {t('solutions.installs_unknown', 'How often this Solution has been installed could not be read, so this is not "never".')}
                </Strip>
            )),
        ];
        return <TabBlocks blocks={blocks} onRefresh={() => installs.refetch()} />;
    }
    const h = { count: counts.here ?? 0 };
    const e = { count: counts.elsewhere ?? 0 };
    const here =
        counts.here === null
            ? t('solutions.installs_here_unknown', 'How many were installed in your organisation could not be read.')
            : byCount(h.count, t('solutions.installs_here', '{count} Solution in your organisation came from this Blueprint', h), t('solutions.installs_here_plural', '{count} Solutions in your organisation came from this Blueprint', h));
    const elsewhere =
        counts.elsewhere === null
            ? t('solutions.installs_elsewhere_unknown', 'How many were installed elsewhere on this instance could not be read.')
            : byCount(e.count, t('solutions.installs_elsewhere', '{count} other Solution elsewhere on this instance came from it', e), t('solutions.installs_elsewhere_plural', '{count} other Solutions elsewhere on this instance came from it', e));
    const blocks = [
        block('here', () => <Text variant="body" tone={counts.here === null ? 'tertiary' : 'primary'} testID="installs-here">{here}</Text>, 'none'),
        block('elsewhere', () => <Text variant="body" tone={counts.elsewhere === null ? 'tertiary' : 'primary'} testID="installs-elsewhere">{elsewhere}</Text>, 'inner'),
        block('lower-bound', () => (
            <Strip tone="muted">
                {t('solutions.installs_incomplete', 'These are at least this many — only installations on this instance are counted, and only where the install could be tied back to this Blueprint. A copy installed on another instance is invisible here.')}
            </Strip>
        )),
        ...(counts.here === 0 && counts.elsewhere === 0
            ? [block('none-yet', () => <Strip tone="quiet">{t('solutions.installs_none', 'No installation on this instance could be tied back to this Blueprint yet.')}</Strip>, 'inner')]
            : []),
    ];
    return <TabBlocks blocks={blocks} onRefresh={() => installs.refetch()} />;
}
