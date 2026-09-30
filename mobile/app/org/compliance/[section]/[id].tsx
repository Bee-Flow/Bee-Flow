/** One record of a register, or one check of a framework. See features/compliance. */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ComplianceRecordScreen } from '@/features/compliance';

export default function ComplianceRecordRoute() {
    const { section, id } = useLocalSearchParams<{ section: string; id: string }>();
    return <ComplianceRecordScreen section={section} id={id} />;
}
