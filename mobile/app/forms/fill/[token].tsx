/**
 * Fill a form in, by its page token — where a form's link and the web's
 * /app/forms/<token> land. `?s=` resumes a journey under way. The screen
 * lives in features/forms.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { FillFormScreen } from '@/features/forms';

export default function FillFormRoute() {
    const { token, s } = useLocalSearchParams<{ token: string; s?: string }>();
    return <FillFormScreen token={typeof token === 'string' ? token : ''} resume={typeof s === 'string' ? s : null} />;
}
