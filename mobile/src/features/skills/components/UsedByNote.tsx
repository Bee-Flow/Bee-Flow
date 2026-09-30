/**
 * The standing note under the method (the web's UsedByNote): who uses this
 * skill, and the one sentence that makes editing it feel safe — "a change
 * here applies everywhere at once". It only claims a count it HAS: nothing
 * while the read is out or failed, a narrower sentence when the server could
 * not check every kind.
 */

import React from 'react';

import type { UsageAnswer } from '@/core/api/usage';
import { useTranslation } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';
import { Card, Text } from '@/shared/ui';

export function UsedByNote({ usage }: { usage: UsageAnswer | undefined }) {
    const t = useTranslation();
    if (!usage) return null;
    if (usage.unchecked.length > 0) {
        return (
            <Card>
                <Text variant="caption" tone="warning">
                    {t('skills_studio.usage.partial', 'Not everything could be checked, so this list may be short. A change here applies everywhere at once.')}
                </Text>
            </Card>
        );
    }
    const n = usage.usage.length;
    return (
        <Card>
            <Text variant="caption" tone="secondary">
                {n === 0
                    ? t('skills_studio.usage.empty', 'No agent or automation uses this skill yet.')
                    : nOf(t, 'skills_studio.usage.note', n, [
                          'Used by {count} agent or automation. A change here applies everywhere at once.',
                          'Used by {count} agents and automations. A change here applies everywhere at once.',
                      ])}
            </Text>
        </Card>
    );
}
