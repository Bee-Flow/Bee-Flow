/**
 * One form in the directory (the web's FormsStudio row): the title, Live or
 * Not live, whether it collects its answers, who may fill it in (the owner's
 * one-glance answer), and the submissions — lastSeenAt is stamped on every
 * accepted one, so it is the honest "is anyone using this" signal.
 */

import React from 'react';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { Badge, ListRow } from '@/shared/ui';

import { audienceGist, formLiveness } from '../model/formPage';
import type { FormSummary } from '../model/types';

function audienceWords(t: TranslateFn, form: FormSummary): string | null {
    if (!form.mine) return null;
    const gist = audienceGist(form.audience);
    if (gist.kind === 'org') return t('forms.studio.audience_org', 'Everyone in the organisation');
    if (gist.kind === 'nobody') return t('forms.studio.audience_nobody', 'Only you — not shared yet');
    return gist.count === 1
        ? t('forms.studio.audience_restricted', 'Shared with {count} person or group', { count: gist.count })
        : t('forms.studio.audience_restricted_plural', 'Shared with {count} people and groups', { count: gist.count });
}

export function formRowSubtitle(t: TranslateFn, form: FormSummary): string {
    const submissions =
        form.submissions === 1
            ? t('forms.studio.submissions', '{count} submission', { count: form.submissions })
            : t('forms.studio.submissions_plural', '{count} submissions', { count: form.submissions });
    const last = form.lastSeenAt ? t('forms.studio.last_submission', 'last {when}', { when: timeAgo(form.lastSeenAt) }) : null;
    const collects = form.answers?.collecting ? t('forms.studio.collects_chip', 'collects answers') : null;
    return [submissions, last, collects, audienceWords(t, form)].filter(Boolean).join(' · ');
}

export function FormRow({ form, onPress }: { form: FormSummary; onPress?: () => void }) {
    const t = useTranslation();
    const live = formLiveness(form) === 'live';
    return (
        <ListRow
            title={form.title || t('forms.studio.untitled', 'Untitled form')}
            subtitle={formRowSubtitle(t, form)}
            wrapTitle
            trailing={<Badge label={live ? t('forms.status.live', 'Live') : t('forms.status.off', 'Not live')} tone={live ? 'success' : 'neutral'} />}
            onPress={onPress}
            disabled={!onPress}
            testID={`form-row-${form.id}`}
        />
    );
}
