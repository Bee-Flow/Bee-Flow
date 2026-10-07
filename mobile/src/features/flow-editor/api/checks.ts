/**
 * The read-out about an automation the web builder shows beside its flow:
 *
 *   - POST /api/automation/:id/diagnose-trigger
 *     (routes/automation/diagnoseTrigger.js, mounted by runs.js; needs edit
 *     access): probes an app-event trigger's pipeline — the integration, the
 *     credentials, the subscription, a recent match — read-only. Each check
 *     is `ok | warn | error | skipped`, with an optional `detail`;
 *
 * The AI Act declaration moved to features/ai-act (it serves agents too).
 */

import { api } from '@/core/api/client';
import { field, shapeOf } from '@/core/api/contract';

import { flowPath } from './definition';

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skipped';

export interface TriggerCheck {
    name: string;
    status: CheckStatus;
    message: string;
    detail: unknown;
}

export interface TriggerDiagnosis {
    ok: boolean;
    kind: string;
    checks: TriggerCheck[];
}

const readCheck = shapeOf({
    name: field.str(''),
    status: field.oneOf<CheckStatus>(['ok', 'warn', 'error', 'skipped'], 'skipped'),
    message: field.str(''),
    detail: field.raw,
});

export const readDiagnosis: (raw: unknown) => TriggerDiagnosis = shapeOf({
    ok: field.bool(false),
    kind: field.str('unknown'),
    checks: field.list(readCheck),
});

export async function diagnoseTrigger(id: string): Promise<TriggerDiagnosis> {
    return readDiagnosis(await api.post<unknown>(`${flowPath(id)}/diagnose-trigger`, {}, { retry: false }));
}
