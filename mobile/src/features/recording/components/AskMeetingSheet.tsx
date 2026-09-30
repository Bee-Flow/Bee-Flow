/** "Ask about this meeting": the throwaway chat of MeetingChatSheet, in its sheet. */

import React from 'react';
import { View } from 'react-native';

import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Sheet } from '@/shared/ui';

import { MeetingChatSheetBody } from './MeetingChatSheet';
import { makeMeetingStyles } from './meetingStyles';
import type { Transcription } from '../model/types';

export function AskMeetingSheet({
    visible,
    meeting,
    onClose,
}: {
    visible: boolean;
    meeting: Transcription;
    onClose: () => void;
}) {
    const styles = useThemedStyles(makeMeetingStyles);
    return (
        <Sheet visible={visible} onClose={onClose} title="Ask about this meeting" scroll={false}>
            <View style={styles.askBody}>
                <MeetingChatSheetBody meeting={meeting} />
            </View>
        </Sheet>
    );
}
