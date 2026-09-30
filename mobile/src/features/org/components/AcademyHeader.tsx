/**
 * The Academy overview's top: the web's four totals and its course filter
 * ("All courses" / "Completed: <course>"), as chips. The course list is the
 * product's catalogue, a handful of rows.
 */

import React from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Chip, Stat } from '@/shared/ui';

import type { AcademyOverview } from '../model/sectionTypes';

const makeStyles = (theme: Theme) => ({
    wrap: { gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md } satisfies ViewStyle,
    stats: { flexDirection: 'row', gap: theme.spacing.md } satisfies ViewStyle,
    chips: { gap: theme.spacing.sm } satisfies ViewStyle,
});

const shown = (n: number | null) => (n === null ? '—' : String(n));

export function AcademyHeader({
    overview,
    courseId,
    onCourse,
}: {
    overview: AcademyOverview | null | undefined;
    courseId: string | null;
    onCourse: (id: string | null) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const totals = overview?.totals;
    return (
        <View style={styles.wrap}>
            <Card>
                <View style={styles.stats}>
                    <Stat label={t('org.academy.members', 'Members')} value={shown(totals?.members ?? null)} />
                    <Stat
                        label={t('org.academy.courses_completed', 'Courses completed')}
                        value={shown(totals?.coursesCompleted ?? null)}
                        tone="accent"
                    />
                </View>
                <View style={styles.stats}>
                    <Stat
                        label={t('org.academy.certificates', 'Certificates issued')}
                        value={shown(totals?.certificatesIssued ?? null)}
                    />
                    <Stat
                        label={t('org.academy.active_30d', 'Active last 30 days')}
                        value={shown(totals?.activeLast30d ?? null)}
                    />
                </View>
            </Card>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                <Chip label={t('org.academy.all_courses', 'All courses')} selected={!courseId} onPress={() => onCourse(null)} />
                {(overview?.courses ?? []).map((course) => (
                    <Chip
                        key={course.id}
                        testID={`academy-course-${course.id}`}
                        label={`${t('org.academy.completed_prefix', 'Completed:')} ${course.title}`}
                        selected={courseId === course.id}
                        onPress={() => onCourse(course.id)}
                    />
                ))}
            </ScrollView>
        </View>
    );
}
