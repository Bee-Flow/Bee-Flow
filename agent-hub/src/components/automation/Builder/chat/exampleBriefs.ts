import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * Three briefs a person could have written themselves, in their own words.
 * The empty canvas and the assistant's welcome both offer them, and a click
 * SENDS one: it is an example of how to talk to the assistant, not a form to
 * fill in.
 */
export function exampleBriefs(t: TranslateFn): string[] {
    return [
        t('automations.assistant.brief.contact_form', 'When someone fills in the contact form, save the answers in a table and email me a short summary'),
        t('automations.assistant.brief.weekly_digest', 'Every Monday at 9:00, summarise last week\'s new rows in a table and email the summary to the team'),
        t('automations.assistant.brief.invoice_approval', 'When an invoice arrives by email, read the amount and the due date and ask a colleague to approve it'),
    ];
}
