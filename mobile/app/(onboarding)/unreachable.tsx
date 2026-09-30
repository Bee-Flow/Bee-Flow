/** The server cannot be reached; the sign-in is intact (auth stage `unreachable`). The screen lives in features/onboarding. */

import React from 'react';

import { UnreachableScreen } from '@/features/onboarding';

export default function UnreachableRoute() {
    return <UnreachableScreen />;
}
