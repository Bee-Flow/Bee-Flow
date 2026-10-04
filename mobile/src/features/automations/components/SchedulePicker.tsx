/**
 * The schedule a phone is allowed to change.
 *
 * The builder (web, or the flow editor's schedule trigger) writes any 5-field
 * cron. This quick picker offers five shapes and refuses to touch anything else — a cron field editor at thumb size is a way
 * to break a live automation by accident, and "every 15 minutes on weekdays in
 * Q4" is not a thing anyone should be editing on a train.
 *
 * The preview under the picker is NOT computed here. It comes from
 * POST /api/automation/_schedule/preview, which runs the same
 * `cron.nextRunAt` the scheduler itself uses — so the three times shown are
 * the three times that will actually happen, including the timezone's own
 * daylight-saving oddities, rather than a plausible-looking phone-side guess.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button } from '@/shared/ui';

import { CustomScheduleNotice } from './CustomScheduleNotice';
import { ScheduleFields } from './ScheduleFields';
import { SchedulePreviewBox } from './SchedulePreviewBox';
import { useSchedulePreview } from '../hooks/queries';
import { DEFAULT_SIMPLE_SCHEDULE, cronFromSimple, simpleFromCron, type SimpleSchedule } from '../model/cron';

const makeStyles = (theme: Theme) => StyleSheet.create({ root: { gap: theme.spacing.lg } });

export function SchedulePicker({
    cron,
    tz,
    saving,
    onSave,
}: {
    cron: string | null;
    tz: string;
    saving: boolean;
    onSave: (cron: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const parsed = simpleFromCron(cron);
    /** A pattern the picker cannot represent stays untouched until asked. */
    const [replacingCustom, setReplacingCustom] = useState(false);
    const [schedule, setSchedule] = useState<SimpleSchedule>(parsed ?? DEFAULT_SIMPLE_SCHEDULE);

    // A different automation's schedule can arrive while this sheet is mounted, and
    // a save rewrites the one it already shows. Reset during render rather than
    // in an effect: an effect would leave the old times on screen for a frame.
    const [lastCron, setLastCron] = useState(cron);
    if (lastCron !== cron) {
        setLastCron(cron);
        setSchedule(parsed ?? DEFAULT_SIMPLE_SCHEDULE);
        setReplacingCustom(false);
    }

    const nextCron = cronFromSimple(schedule);
    const preview = useSchedulePreview(nextCron, tz);

    if (cron && !parsed && !replacingCustom) {
        return <CustomScheduleNotice cron={cron} tz={tz} onReplace={() => setReplacingCustom(true)} />;
    }

    return (
        <View style={styles.root}>
            {replacingCustom ? (
                <Banner tone="warning">
                    Saving replaces the custom pattern. The old expression is not kept.
                </Banner>
            ) : null}

            <ScheduleFields schedule={schedule} update={setSchedule} />

            <SchedulePreviewBox cron={nextCron} tz={tz} preview={preview} />

            <Button label="Save schedule" onPress={() => onSave(nextCron)} loading={saving} fullWidth size="lg" />
        </View>
    );
}
