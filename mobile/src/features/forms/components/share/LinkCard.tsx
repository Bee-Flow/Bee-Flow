/**
 * The form's address (the web's PublicLinkCard): share it, open it, or mint a
 * new one — the old link stops working at once, because the token IS the
 * credential. A rotated link keeps its audience. Taking the link down is
 * here too, behind a warning: the form then has no address (and leaves the
 * forms list) until its automation is saved again, and that new link starts
 * shared with nobody.
 *
 * Forms are signed-in only, and the blurb says so: telling someone to send
 * "the public link" to a customer would be a wasted afternoon.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { publicFormUrl } from '@/features/forms/api/endpoints';
import { useFormLinkActions } from '@/features/forms/hooks/mutations';
import type { FormDetail } from '@/features/forms/model/types';
import { LinkActions } from '@/features/webpages';
import { Button, Card, ConfirmSheet, Section, Text, useToast } from '@/shared/ui';

type Asking = 'rotate' | 'remove' | null;

export function LinkCard({ form }: { form: FormDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const { toast } = useToast();
    const links = useFormLinkActions(form.automationId);
    const [asking, setAsking] = useState<Asking>(null);
    const url = publicFormUrl(form);
    const act = async (what: Exclude<Asking, null>) => {
        setAsking(null);
        try {
            if (what === 'rotate') {
                await links.rotate(form.id);
                toast(t('mobile.forms.link_rotated', 'New link made — the old one no longer works'), 'success');
            } else {
                await links.remove(form.id);
                toast(t('mobile.forms.link_removed', 'The link is down'), 'success');
                router.back();
            }
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };
    return (
        <Section title={t('forms.share.link_title', 'Link to the form')}>
            <Card>
                <View style={styles.body}>
                    <Text variant="caption" tone="secondary">
                        {form.audience.mode === 'restricted'
                            ? t('forms.share.link_blurb_restricted', 'Only the people and groups listed under “Who can fill it in” can open this link, after signing in. It only works while the form is live.')
                            : t('forms.share.link_blurb', 'Colleagues in your organisation can open this link after signing in. It only works while the form is live.')}
                    </Text>
                    {url ? (
                        <>
                            <Text variant="code" selectable accessibilityLabel={t('forms.share.link_label', 'Form address')} testID="form-link">
                                {url}
                            </Text>
                            <LinkActions url={url} shareTitle={form.title} />
                        </>
                    ) : (
                        <Text variant="caption" tone="tertiary">
                            {t('forms.share.link_generating', 'The link is being created — save the form once and it appears here.')}
                        </Text>
                    )}
                    {form.mine && url ? (
                        <View style={styles.row}>
                            <Button size="sm" variant="secondary" iconName="RefreshCw" label={t('forms.share.link_rotate', 'New link')} onPress={() => setAsking('rotate')} loading={links.busy} testID="form-link-rotate" />
                            <Button size="sm" variant="ghost" iconName="Unlink" label={t('mobile.forms.link_remove', 'Take the link down')} onPress={() => setAsking('remove')} disabled={links.busy} />
                        </View>
                    ) : null}
                </View>
            </Card>
            <ConfirmSheet
                visible={asking === 'rotate'}
                title={t('forms.share.link_rotate_title', 'Create a new link?')}
                message={t('forms.share.link_rotate_body', 'The current link stops working immediately — anyone who already has it will see “not available”.')}
                confirmLabel={t('forms.share.link_rotate_confirm', 'Create a new link')}
                onConfirm={() => void act('rotate')}
                onCancel={() => setAsking(null)}
            />
            <ConfirmSheet
                visible={asking === 'remove'}
                title={t('mobile.forms.link_remove_title', 'Take the link down?')}
                message={t(
                    'mobile.forms.link_remove_body',
                    'The address stops working at once and the form leaves the forms list. Its automation stays: saving it makes a new link, shared with nobody until you add people again.',
                )}
                confirmLabel={t('mobile.forms.link_remove', 'Take the link down')}
                onConfirm={() => void act('remove')}
                onCancel={() => setAsking(null)}
            />
        </Section>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.md } satisfies ViewStyle,
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
});
