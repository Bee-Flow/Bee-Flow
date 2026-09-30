/** Enrol an authenticator (auth stage `mfa-setup-required`). The screen lives in features/onboarding. */

import React from 'react';

import { MfaSetupScreen } from '@/features/onboarding';

export default function MfaSetupRoute() {
    return <MfaSetupScreen />;
}
