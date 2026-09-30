/**
 * Running a Studio app on a phone.
 *
 * The desktop renderer draws the whole component tree. This draws the half of
 * it that a phone can honestly own — fill in a form, press the button, read
 * what came back — and says plainly which components it left out. See
 * model/appDefinition.ts for why that boundary sits where it does, and
 * ActionRunner.tsx for the run contract.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner } from '@/shared/ui';

import { BlockView } from './BlockView';
import type { AppPlan } from '../model/appDefinition';

const makeStyles = (theme: Theme) => StyleSheet.create({ root: { gap: theme.spacing.lg } });

/** `draft`: the runtime is the owner's draft (its `draft` flag), so every run goes to the draft. */
export function AppRunner({ appId, draft = false, plan }: { appId: string; draft?: boolean; plan: AppPlan }) {
    const styles = useThemedStyles(makeStyles);

    return (
        <View style={styles.root}>
            {plan.blocks.map((block) => (
                <BlockView key={block.id} appId={appId} draft={draft} block={block} />
            ))}

            {plan.unsupported.length > 0 ? (
                <Banner tone="info" icon="Monitor">
                    {`This screen also has ${plan.unsupported.join(', ')}. Those parts need the full app in a browser — everything above works here.`}
                </Banner>
            ) : null}
        </View>
    );
}
