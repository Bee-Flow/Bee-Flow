/**
 * What an enabled answer cache may keep, and for how long: the web's two
 * scope ticks (two different promises — connected apps versus any address a
 * automation author types in) and its minute slider, as a Stepper.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, NoteRow, Stepper, ToggleRow } from '@/shared/ui';

import { fill, minutesOf } from '../model/format';
import type { IntegrationCacheBody } from '../model/sectionTypes';

export function IntegrationCacheScopes({
    draft,
    range,
    disabled,
    onScopes,
    onTtl,
}: {
    draft: IntegrationCacheBody;
    range: { min: number; max: number };
    disabled: boolean;
    onScopes: (scopes: IntegrationCacheBody['scopes']) => void;
    onTtl: (seconds: number) => void;
}) {
    const t = useTranslation();
    const { scopes } = draft;
    return (
        <>
            <Group
                title={t('admin.integration_cache.scopes_label', 'What may be kept')}
                footer={t(
                    'admin.integration_cache.scopes_note',
                    'These are two different promises. The first is about apps this organisation connected and whose permissions it manages. The second is about any web address an automation author types in, so it is off until you say otherwise.',
                )}
            >
                <ToggleRow
                    testID="cache-scope-integration"
                    label={t('admin.integration_cache.scope_integration', 'Answers from connected apps')}
                    description={t(
                        'admin.integration_cache.scope_integration_desc',
                        'Look-ups an automation makes through an app action — a calendar, a mailbox, a ticket system.',
                    )}
                    value={scopes.integration}
                    disabled={disabled}
                    onValueChange={(integration) => onScopes({ ...scopes, integration })}
                />
                <ToggleRow
                    testID="cache-scope-http"
                    label={t('admin.integration_cache.scope_http', 'Answers from web service calls')}
                    description={t(
                        'admin.integration_cache.scope_http_desc',
                        'Replies to a "Call a web service" step, which can point at any address the automation author chooses. Only ever GET and HEAD, and never when that step is allowed to reach private addresses.',
                    )}
                    value={scopes.http}
                    disabled={disabled}
                    onValueChange={(http) => onScopes({ ...scopes, http })}
                />
            </Group>
            <Group title={t('admin.integration_cache.ttl_label', 'How long an answer may be reused')}>
                <Stepper
                    testID="cache-ttl"
                    label={t('admin.integration_cache.ttl_label', 'How long an answer may be reused')}
                    value={draft.ttlSeconds}
                    min={range.min}
                    max={range.max}
                    step={60}
                    format={(v) => fill(t('admin.integration_cache.ttl_minutes', '{{n}} minutes'), { n: minutesOf(v) })}
                    disabled={disabled}
                    onChange={onTtl}
                />
                <NoteRow>
                    {t(
                        'admin.integration_cache.ttl_note',
                        'After this, the answer is deleted and the next run asks the app again. This is also the longest a run can be working from stale data. Shortening it applies to answers already stored, not just new ones.',
                    )}
                </NoteRow>
            </Group>
        </>
    );
}
