/**
 * Saved changes that are not live yet (handoff 5). Once a routine has gone
 * live, a save only changes its working copy: runs keep executing the live
 * version until that copy is made live. The web says so beside its status
 * pill ("editing v5 · 2 changes not live yet") and offers "Make v5 live";
 * this is that line and that button, in the banner the agent editor uses for
 * its own saved-but-not-published changes (agents' EditorBanners).
 *
 * The button is there while the routine is switched on (the web's `publish`
 * primary). On a paused routine the line alone says what is pending: Go live
 * switches the live version back on, and the pending changes then get the
 * button. Like the web's, it waits for the autosave, so what goes live is the
 * version on screen, and it sends that version along: a routine saved
 * elsewhere in the meantime is read again and the person is told.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { isVersionChanged } from '@/features/flow-editor/api';
import { useDraftState, usePublishFlow } from '@/features/flow-editor/hooks';
import type { DraftStore } from '@/features/flow-editor/state';
import { Banner, Button, useToast } from '@/shared/ui';

import { reportLiveRefusal } from './liveRefusal';
import { pendingText, type LiveState } from './liveState';

export interface PublishBannerProps {
    flowKey: string;
    store: DraftStore;
    /** Null on a server without the live split: nothing is drawn. */
    live: LiveState | null;
    /** A trigger and at least one step: something that can run. */
    canPublish: boolean;
    /** The AI is building or a test is running. */
    busy: boolean;
    /** Show the findings a refusal came with. */
    onFindings: () => void;
}

function usePublish({ flowKey, onFindings }: Pick<PublishBannerProps, 'flowKey' | 'onFindings'>) {
    const t = useTranslation();
    const { toast } = useToast();
    return usePublishFlow(flowKey, {
        onSuccess: (result, version) =>
            toast(t('routines.header.make_live_title', 'Runs use v{version} from now on', { version: result.automation?.liveVersion ?? version ?? '' }), 'success'),
        onError: (err) => {
            if (!isVersionChanged(err)) {
                reportLiveRefusal(err, toast, onFindings);
                return;
            }
            toast(
                t(
                    'mobile.flow.publish.version_changed',
                    'This routine was saved elsewhere in the meantime. The latest version is shown now; check it, then make it live.',
                ),
                'error',
            );
        },
    });
}

export function PublishBanner({ flowKey, store, live, canPublish, busy, onFindings }: PublishBannerProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    // A save pending or in flight: going live now would publish the version before the last edit.
    const saving = useDraftState(store, (s) => s.dirty || s.status === 'pending' || s.status === 'saving');
    const publish = usePublish({ flowKey, onFindings });
    const text = live ? pendingText(live, t) : null;
    if (!live || !text) return null;
    const version = live.workingVersion;
    const hint = !canPublish
        ? t('routines.header.activate_incomplete', 'Add a trigger and at least one step first')
        : saving
          ? t('routines.header.wait_for_save', 'Saving your last change first')
          : t('routines.header.make_live_title', 'Runs use v{version} from now on', { version: version ?? '' });
    const action =
        live.primary === 'publish' ? (
            <Button
                size="sm"
                iconName="Upload"
                label={t('routines.header.make_live', 'Make v{version} live', { version: version ?? '' })}
                accessibilityHint={hint}
                disabled={busy || saving || !canPublish || publish.isPending}
                loading={publish.isPending}
                onPress={() => publish.mutate(version)}
                testID="publish-live"
            />
        ) : undefined;
    return (
        <View style={styles.slot} testID="publish-banner">
            <Banner tone="info" icon="Upload" action={action}>
                {text}
            </Banner>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    slot: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[2] } satisfies ViewStyle,
});
