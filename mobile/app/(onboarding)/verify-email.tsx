/** Confirm the email address first (auth stage `email-verification-required`). The screen lives in features/onboarding. */

import React from 'react';

import { VerifyEmailScreen } from '@/features/onboarding';

export default function VerifyEmailRoute() {
    return <VerifyEmailScreen />;
}
