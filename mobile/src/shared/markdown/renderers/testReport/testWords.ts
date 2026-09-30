/**
 * The test report's status words and glyphs. Borrowed where the web already
 * says the word for a run's status (`run_status.*`), the phone's own key
 * where it does not ("Passed").
 */

import type { TranslateFn } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import type { TestCategory, TestStatus } from './testReportModel';

export function statusLabel(status: TestStatus, t: TranslateFn): string {
    switch (status) {
        case 'passed':
            return t('mobile.markdown.test_passed', 'Passed');
        case 'failed':
            return t('run_status.error', 'Failed');
        case 'warning':
            return t('run_status.warning', 'Warning');
        default:
            return t('run_status.skipped', 'Skipped');
    }
}

export const STATUS_ICON: Record<TestStatus, IconName> = {
    passed: 'CircleCheck',
    failed: 'CircleX',
    warning: 'TriangleAlert',
    skipped: 'Clock',
};

export const CATEGORY_ICON: Record<TestCategory, IconName> = {
    functionality: 'Zap',
    ui: 'Eye',
    performance: 'Clock',
    accessibility: 'Shield',
    security: 'Bug',
};
