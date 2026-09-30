/**
 * Update this Solution to the newer Blueprint it came from — the plan first,
 * then the button (the web's UpgradeDialog).
 *
 * Confirming is reachable ONLY from a plan that was read and that changes
 * something. A plan that could not be worked out offers no "go ahead
 * anyway": nothing is known about what would happen, which is the one state
 * in which this act must not be offered. The plan is asked afresh each time
 * the sheet opens; an old plan next to a live button is the mistake the plan
 * exists to prevent.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, LoadingState, Sheet } from '@/shared/ui';

import { Strip } from './Strip';
import { PlanView, ReportView } from './UpgradePlanView';
import { useApplyUpgrade } from '../hooks/packageMutations';
import { useUpgradePlan } from '../hooks/solutionQueries';
import type { UpgradeReport } from '../model/package';
import { planTouchesNothing } from '../model/upgrade';

export function UpgradeSheet({
    projectId,
    blueprintId,
    latestVersion,
    onClose,
}: {
    projectId: string;
    /** Only an id that passed the org-scoped gallery: null keeps the sheet shut. */
    blueprintId: string | null;
    latestVersion: number | null;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const plan = useUpgradePlan(projectId, blueprintId);
    const [report, setReport] = useState<UpgradeReport | null>(null);
    const apply = useApplyUpgrade(projectId, setReport);
    const ready = plan.isSuccess && !report;
    const empty = ready && planTouchesNothing(plan.data.rows);

    const footer = (
        <>
            {ready && !empty ? (
                <Button
                    label={t('solutions.upgrade_confirm', 'Update it')}
                    onPress={() => blueprintId && apply.mutate(blueprintId)}
                    loading={apply.isPending}
                    fullWidth
                    size="lg"
                    testID="upgrade-confirm"
                />
            ) : null}
            <Button
                label={report ? t('solutions.upgrade_close', 'Close') : t('solutions.upgrade_cancel', 'Cancel')}
                onPress={onClose}
                variant="ghost"
                fullWidth
            />
        </>
    );

    return (
        <Sheet
            visible={blueprintId !== null}
            onClose={onClose}
            title={t('solutions.upgrade_title', 'Update this Solution')}
            subtitle={latestVersion === null ? undefined : t('solutions.upgrade_intro', 'To version {version} of the Blueprint it came from.', { version: latestVersion })}
            footer={footer}
        >
            <View style={styles.stack}>
                {plan.isLoading ? <LoadingState /> : null}
                {plan.isError ? (
                    <Strip tone="error" testID="upgrade-plan-unreadable">
                        {t('solutions.upgrade_plan_unreadable', 'What this update would change could not be worked out, so nothing has been applied.')}
                    </Strip>
                ) : null}
                {empty ? <Strip tone="muted">{t('solutions.upgrade_nothing', 'This update would not change or add anything here.')}</Strip> : null}
                {ready ? <PlanView rows={plan.data.rows} /> : null}
                {apply.isError ? (
                    <Strip tone="error">
                        {t('solutions.upgrade_apply_failed', 'The update did not go through. Nothing that was already replaced is undone — try again, and read the plan first.')}
                    </Strip>
                ) : null}
                {report ? <ReportView report={report} /> : null}
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    stack: { gap: theme.spacing.md } satisfies ViewStyle,
});
