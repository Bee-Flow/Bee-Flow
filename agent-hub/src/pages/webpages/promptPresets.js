/**
 * The four examples on the overview's dashed "Start from an example" card
 * (Webpages artboard 1a, plan W1).
 *
 * They are PROMPT PRESETS, not templates — a deliberate deviation from the
 * design, which draws them as if a template entity existed. It does not: a
 * webpage is three file slots plus a chat, and there is nothing to instantiate.
 * Clicking one fills the build bar with a brief the user can still edit, which
 * is both honest about what happens next and better than a fixed skeleton the
 * AI has to argue its way out of.
 *
 * The labels are the artboard's own four phrases, in its order.
 */
export default function promptPresets(t) {
    return [
        {
            id: 'status_page',
            label: t('webpages.examples.status_page', 'Status page on a table'),
            prompt: t(
                'webpages.examples.status_page_prompt',
                'A status page where a customer types their reference number and sees the current status of their request, read from one of my tables. Show nothing until a number is entered.',
            ),
        },
        {
            id: 'intake_form',
            label: t('webpages.examples.intake_form', 'Intake form → automation'),
            prompt: t(
                'webpages.examples.intake_form_prompt',
                'An intake form that collects a name, an email address and a short description, and starts one of my automations when it is submitted. Confirm on the page that it was received.',
            ),
        },
        {
            id: 'run_dashboard',
            label: t('webpages.examples.run_dashboard', 'Dashboard on an automation run'),
            prompt: t(
                'webpages.examples.run_dashboard_prompt',
                'A dashboard that shows the result of the latest run of one of my automations: the headline numbers on top, the detail underneath, and when it last updated.',
            ),
        },
        {
            id: 'agent_chat',
            label: t('webpages.examples.agent_chat', 'Chat with an agent'),
            prompt: t(
                'webpages.examples.agent_chat_prompt',
                'A page with a short introduction and a chat panel underneath where a visitor can ask questions, answered by the AI using this page as its ground truth.',
            ),
        },
    ];
}
