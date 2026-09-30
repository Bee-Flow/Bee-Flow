/** One section of the Compliance Center (a framework, a register, settings). See features/compliance. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ComplianceSectionScreen } from '@/features/compliance';

export default function ComplianceSectionRoute() {
    const { section } = useLocalSearchParams<{ section: string }>();
    return <ComplianceSectionScreen section={section} />;
}
