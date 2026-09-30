/**
 * Invite someone who has no account yet — the web's invite form: an e-mail
 * address and the role they arrive with ("User" by default). Refusals are the
 * server's own sentences: the 429 of the per-inviter limit (20 an hour) and
 * the per-address cooldown, a 409 for someone already in the organisation,
 * and the seat cap — which, as on the web, points at the plans instead of
 * ending there.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { email, FormSheet, required, useForm } from '@/shared/patterns';
import { Button, Group, OptionRow, TextField } from '@/shared/ui';

import { useInviteMember } from '../hooks/memberMutations';
import { PLAIN_USER_ROLE, roleCopy } from '../model/roles';
import type { InviteResult } from '../model/types';

export function isSeatCapRefusal(error: unknown): boolean {
    return error instanceof ApiError && error.code === 'seat_cap_exceeded';
}

export function InviteSheet({
    visible,
    onClose,
    roleIds,
    onInvited,
}: {
    visible: boolean;
    onClose: () => void;
    /** 'user' plus the org roles, in picker order. */
    roleIds: readonly string[];
    onInvited: (result: InviteResult, address: string) => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    const invite = useInviteMember();
    const form = useForm({
        initial: { email: '', role: PLAIN_USER_ROLE },
        validate: {
            email: [
                required(t('mobile.orgPeople.email_required', 'Enter an e-mail address.')),
                email(t('mobile.orgPeople.email_invalid', 'That does not look like an e-mail address.')),
            ],
        },
        onSubmit: async (values) => {
            const address = values.email.trim();
            const result = await invite.mutateAsync({ email: address, role: values.role });
            form.reset();
            onInvited(result, address);
        },
    });
    const close = () => {
        form.reset();
        onClose();
    };

    return (
        <FormSheet
            visible={visible}
            onClose={close}
            title={t('admin.org_invite_user', 'Invite User')}
            submitLabel={t('mobile.orgPeople.send_invite', 'Send invitation')}
            onSubmit={() => void form.submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit}
            error={form.submitError}
        >
            {isSeatCapRefusal(form.submitError) ? (
                <Button
                    variant="secondary"
                    label={t('agent_wizard.view_plans', 'View plans & upgrade')}
                    onPress={() => {
                        close();
                        router.push('/org/billing/plans');
                    }}
                />
            ) : null}
            <TextField
                testID="invite-email"
                label={t('mobile.orgPeople.email', 'Email')}
                placeholder={t('mobile.orgPeople.email_placeholder', 'colleague@example.com')}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                {...form.field('email')}
            />
            <Group title={t('mobile.orgPeople.role', 'Role')}>
                {roleIds.map((id) => (
                    <OptionRow
                        key={id}
                        testID={`invite-role-${id}`}
                        label={roleCopy(id, t).name}
                        selected={form.values.role === id}
                        onPress={() => form.set('role', id)}
                    />
                ))}
            </Group>
        </FormSheet>
    );
}
