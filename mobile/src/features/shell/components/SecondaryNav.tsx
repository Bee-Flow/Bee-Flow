/**
 * The drawer's second block — of the web Sidebar's secondaryNav, only Agents.
 * Studio, Apps, Forms and Notebooks open from the Studio tab on the phone
 * (its Workspace group and its sections), so the drawer is the chats and the
 * few doors that are not Studio's.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { NavRow } from '@/shared/ui';

import { useDrawerActions } from '../hooks/drawerActions';
import { secondarySpec } from '../model/nav';

export function SecondaryNav() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { push } = useDrawerActions();
    const spec = secondarySpec('agents');
    return (
        <View style={styles.nav}>
            <NavRow
                label={t(spec.labelKey, spec.labelFallback)}
                icon={spec.icon}
                onPress={() => push(spec.href)}
                testID="drawer-agents"
            />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    nav: { paddingTop: theme.spacing[1], gap: theme.spacing[1] } satisfies ViewStyle,
});
