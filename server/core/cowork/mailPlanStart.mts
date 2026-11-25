/**
 * A plan that starts on a new mail (decision 0044): the start data core/cowork/mailTriggerRun.mts hands it. Its own
 * file so the mail run stays one responsibility.
 */

import type { MailMessage } from './mailTriggerRun.mts';

const MAX_STORED_SUBJECT = 300;

/**
 * The start data a plan gets from the mail that started it, as `{{trigger.output.mail.*}}`: who sent it, its subject,
 * its text and where it sits. The fields are the shaped (clipped) message; the run treats all of it as outside text.
 */
export function planTriggerOf(runId: string, provider: 'gmail' | 'outlook', mail: MailMessage) {
    return {
        runId,
        plan: true,
        mailSubject: mail.subject.slice(0, MAX_STORED_SUBJECT),
        payload: {
            start: 'app_event',
            mail: { provider, from: mail.from, to: mail.to, cc: mail.cc, subject: mail.subject, date: mail.date, body: mail.body, messageId: mail.messageId, threadId: mail.threadId },
        },
    };
}

