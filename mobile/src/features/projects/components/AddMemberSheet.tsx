/**
 * Share the project with a person or a group, as a viewer or an editor — the
 * web's Members tab invite row. Owner only (the server says so too).
 *
 * The directory that turns ids into names is only readable by administrators,
 * so for everyone else the picker is an id field, as on the web ("non-admin
 * users may not have access — fall back to ID input"). The server refuses a
 * person or group from another organisation, in its own words.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FormSheet } from '@/shared/patterns';
import { OptionRow, Segmented, Text, TextField } from '@/shared/ui';

import { useShareProject } from '../hooks/mutations';
import { useDirectory } from '../hooks/queries';

type Who = 'user' | 'group';
type Role = 'viewer' | 'editor';

/** A sheet is a ScrollView: the directory can be the whole organisation, so only this many are drawn. */
const SHOWN = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Directory rows of the chosen kind, as options; empty when the caller may not read names. */
function useChoices(who: Who, taken: ReadonlySet<string>) {
    const directory = useDirectory();
    const rows =
        who === 'user'
            ? (directory.data?.users ?? []).map((u) => ({ id: u.id, label: u.displayName || u.username || u.email || u.id }))
            : (directory.data?.groups ?? []).map((g) => ({ id: g.id, label: g.name ?? g.id }));
    return rows.filter((r) => !taken.has(r.id));
}

export function AddMemberSheet({
    projectId,
    visible,
    taken,
    onClose,
}: {
    projectId: string;
    visible: boolean;
    /** Ids already on the project (the owner included). */
    taken: ReadonlySet<string>;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [who, setWho] = useState<Who>('user');
    const [role, setRole] = useState<Role>('viewer');
    const [target, setTarget] = useState('');
    const [needle, setNeedle] = useState('');
    const share = useShareProject(projectId, { onSuccess: onClose });
    const choices = useChoices(who, taken);
    const valid = choices.some((c) => c.id === target) || UUID.test(target.trim());
    const shown = choices.filter((c) => c.label.toLowerCase().includes(needle.trim().toLowerCase())).slice(0, SHOWN);

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.projects.add_member', 'Add people')}
            subtitle={t('solutions.install_access_intro', 'Who else can reach this Solution. You install as its owner either way, and you can change this later on the project page.')}
            submitLabel={t('solutions.install_access_add', 'Add')}
            canSubmit={valid}
            submitting={share.isPending}
            error={share.error}
            onSubmit={() => share.mutate({ sharedWithType: who, sharedWithId: target.trim(), permission: role })}
        >
            <View style={styles.stack}>
                <Segmented<Who>
                    value={who}
                    onChange={(next) => {
                        setWho(next);
                        setTarget('');
                        setNeedle('');
                    }}
                    fullWidth
                    accessibilityLabel={t('solutions.install_access_kind', 'People or groups')}
                    options={[
                        { value: 'user', label: t('solutions.install_access_person', 'Person') },
                        { value: 'group', label: t('solutions.install_access_group', 'Group') },
                    ]}
                />
                <Text variant="label" tone="secondary">
                    {t('solutions.install_access_who', 'Who to add')}
                </Text>
                {choices.length > 0 ? (
                    <>
                        <TextField value={needle} onChangeText={setNeedle} placeholder={t('common.search', 'Search')} autoCorrect={false} />
                        {shown.map((c) => (
                            <OptionRow key={c.id} label={c.label} selected={c.id === target} onPress={() => setTarget(c.id)} />
                        ))}
                    </>
                ) : (
                    <TextField
                        value={target}
                        onChangeText={setTarget}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        autoCapitalize="none"
                        autoCorrect={false}
                        hint={t('mobile.projects.member_id_hint', 'Only administrators see names here. Ask them for the id of the person or group.')}
                    />
                )}
                <Text variant="label" tone="secondary">
                    {t('solutions.install_access_role', 'What they may do')}
                </Text>
                <Segmented<Role>
                    value={role}
                    onChange={setRole}
                    fullWidth
                    options={[
                        { value: 'viewer', label: t('solutions.install_role_viewer', 'Can view') },
                        { value: 'editor', label: t('solutions.install_role_editor', 'Can edit') },
                    ]}
                />
            </View>
        </FormSheet>
    );
}

const makeStyles = (theme: Theme) => ({
    stack: { gap: theme.spacing.md } satisfies ViewStyle,
});
