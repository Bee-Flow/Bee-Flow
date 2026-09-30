/** One usage breakdown (?range= carries the dashboard's range). See features/orgUsage. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { OrgUsageReportScreen } from '@/features/orgUsage';

export default function OrgUsageReportRoute() {
    const { report, range } = useLocalSearchParams<{ report: string; range?: string }>();
    return <OrgUsageReportScreen report={report} range={range} />;
}
