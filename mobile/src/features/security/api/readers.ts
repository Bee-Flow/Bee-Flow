/** Contract readers for the two-factor and app-password payloads. */

import { field, nullable, shapeOf } from '@/core/api/contract';

import type {
    MfaSetup,
    MfaStatus,
    RecoveryCodesResponse,
} from '../model/types';

export const readMfaStatus: (raw: unknown) => MfaStatus | null = nullable(
    shapeOf({
        enabled: field.bool(false),
        recoveryCodesRemaining: field.num(0),
        // Absent reads as "no password", as it did before there was a reader:
        // the Change password row is then disabled rather than offered.
        hasPassword: field.bool(false),
    }),
);

export const readMfaSetup: (raw: unknown) => MfaSetup | null = nullable(
    shapeOf({
        otpauthUrl: field.str(''),
        qr: field.str(''),
        secret: field.str(''),
        serverTime: field.numOrNull,
    }),
);

export const readRecoveryCodes: (raw: unknown) => RecoveryCodesResponse | null = nullable(
    shapeOf({
        success: field.optBool,
        recoveryCodes: field.optStrArray,
        error: field.optStr,
    }),
);
