/**
 * Who can FILL THE FORM IN (the web's FormAudienceCard): only the people and
 * groups the owner lists, or everyone in the organisation — never anyone
 * outside it. Widening to the whole organisation asks first, naming what
 * changes; taking someone off is one tap.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useSetFormAudience } from '@/features/forms/hooks/mutations';
import { granteesOf, withGrantee, withMode, withoutGrantee, type Grantee } from '@/features/forms/model/audience';
import type { FormAudience, FormDetail } from '@/features/forms/model/types';
import { useOrgGroups, useOrgMembers } from '@/features/org';
import { personName } from '@/shared/lib/display';
import { Button, Card, ConfirmSheet, Divider, OptionRow, Section, Text } from '@/shared/ui';

import { AudiencePickerSheet, type AudienceDirectory } from './AudiencePickerSheet';
import { GranteeRow } from './GranteeRow';

function useDirectory(enabled: boolean): AudienceDirectory {
    const members = useOrgMembers({ enabled, staleTime: 60_000 });
    const groups = useOrgGroups(enabled);
    return {
        users: (members.data ?? []).map((m) => ({ id: m.id, name: personName(m), detail: m.email ?? '' })),
        groups: (groups.data ?? []).map((g) => ({ id: g.id, name: g.name || g.id, detail: g.description ?? '' })),
        error: members.error ?? groups.error ?? null,
    };
}

export function AudienceCard({ form }: { form: FormDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const directory = useDirectory(true);
    const [confirmWiden, setConfirmWiden] = useState(false);
    const [adding, setAdding] = useState(false);
    const save = useSetFormAudience(form.automationId);
    const audience = form.audience;
    const write = (next: FormAudience) => save.mutate(next);
    const nameOf = (g: Grantee) => (g.type === 'user' ? directory.users : directory.groups).find((e) => e.id === g.id)?.name || g.id;
    const restricted = audience.mode === 'restricted';
    const rows = granteesOf(audience);
    const busy = save.isPending;
    return (
        <Section title={t('forms.share.audience_title', 'Who can fill it in')}>
            <Card padded={false}>
                <OptionRow
                    label={t('forms.share.audience_restricted', 'Only the people and groups you choose')}
                    description={t('forms.share.audience_restricted_desc', 'Colleagues you list below, and the members of the groups you list. Nobody else in the organisation — and never anyone outside it.')}
                    selected={restricted}
                    onPress={() => !restricted && write(withMode(audience, 'restricted'))}
                    disabled={busy}
                    testID="form-audience-restricted"
                />
                <Divider />
                <OptionRow
                    label={t('forms.share.audience_org', 'Everyone in the organisation')}
                    description={t('forms.share.audience_org_desc', 'Every signed-in colleague with the link. Never anyone outside the organisation.')}
                    selected={!restricted}
                    onPress={() => restricted && setConfirmWiden(true)}
                    disabled={busy}
                    testID="form-audience-org"
                />
            </Card>
            {restricted ? (
                <Card>
                    <View style={styles.list}>
                        {rows.length === 0 ? (
                            <Text variant="caption" tone="tertiary">
                                {t('forms.share.audience_empty', 'Nobody yet — only you can open the form. Add the people or groups it is for.')}
                            </Text>
                        ) : null}
                        {rows.map((g) => (
                            <GranteeRow key={`${g.type}:${g.id}`} type={g.type} name={nameOf(g)} onRemove={() => write(withoutGrantee(audience, g))} disabled={busy} />
                        ))}
                        <Button size="sm" variant="ghost" iconName="Plus" label={t('forms.share.audience_add', 'Add a person or group')} onPress={() => setAdding(true)} disabled={busy} testID="form-audience-add" />
                    </View>
                </Card>
            ) : null}
            {save.isError ? (
                <Text variant="caption" tone="error">
                    {describeError(save.error).message || t('forms.share.audience_failed', 'Could not change who can fill in the form.')}
                </Text>
            ) : null}
            <AudiencePickerSheet
                visible={adding}
                onClose={() => setAdding(false)}
                directory={directory}
                taken={rows}
                onPick={(g) => {
                    setAdding(false);
                    write(withGrantee(audience, g));
                }}
            />
            <ConfirmSheet
                visible={confirmWiden}
                title={t('forms.share.audience_widen_title', 'Open the form to the whole organisation?')}
                message={t('forms.share.audience_widen_body', 'Every signed-in colleague with the link can then fill it in. The people and groups listed stay listed, for when you narrow it again.')}
                confirmLabel={t('forms.share.audience_widen_confirm', 'Open to everyone')}
                tone="primary"
                onConfirm={() => {
                    setConfirmWiden(false);
                    write(withMode(audience, 'org'));
                }}
                onCancel={() => setConfirmWiden(false)}
            />
        </Section>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.xs } satisfies ViewStyle,
});
