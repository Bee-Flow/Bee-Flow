/**
 * One form's page, by its ROUTINE's id (an older link's page token is
 * resolved to its routine by the screen). The screen lives in features/forms.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { FormPageScreen } from '@/features/forms';

export default function FormPageRoute() {
    const { automationId, tab } = useLocalSearchParams<{ automationId: string; tab?: string }>();
    return <FormPageScreen formRef={typeof automationId === 'string' ? automationId : ''} tab={typeof tab === 'string' ? tab : null} />;
}
