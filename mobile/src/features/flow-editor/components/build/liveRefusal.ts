/**
 * A refused Go live or Make live, told the same way: both run the server's
 * pre-live checks (checkBeforeLive in routes/automation/activate.js), so the
 * refusals are the same bodies. The server's reason goes in a toast, and the
 * findings open when the refusal came with some; offline or a 403 is the
 * toast alone.
 */

import { describeError } from '@/core/api/errors';
import { issueDetailsOf } from '@/features/automations';

type Toast = (text: string, tone?: 'success' | 'error') => void;

export function reportLiveRefusal(err: unknown, toast: Toast, onFindings: () => void): void {
    toast(describeError(err).message, 'error');
    if (issueDetailsOf(err).length > 0) onFindings();
}
