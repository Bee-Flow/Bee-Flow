/** Unlock the vault with the encryption PIN (auth stage `encryption-pin-required`). The screen lives in features/onboarding. */

import React from 'react';

import { EncryptionPinScreen } from '@/features/onboarding';

export default function EncryptionPinRoute() {
    return <EncryptionPinScreen />;
}
