/**
 * betaProductText.mts: what the Access screens and the plan editor show for a
 * beta, projected by capabilityRegistry.js.
 *
 * A short, plain, provider-neutral product description. betaCatalog.js keeps
 * the engineering description (what the flag gates, which routes) for the
 * code; the registry is what admins read, so it projects this text instead. A
 * beta missing here keeps its catalogue description. Its name loses a trailing
 * "(Beta)": the row already sits under "Beta features".
 */

export const BETA_PRODUCT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
    meeting_notes: 'Record or upload a meeting and get a transcript, a summary and action items.',
    advanced_analytics: 'Extra usage dashboards and reports.',
    custom_themes: "Your organisation's own branding and colours.",
    skills: 'Reusable instructions, so the AI handles a recurring task the same way every time.',
    flow: 'A chat mode that plans a conversation in stages and prepares skills for it. Needs Skills.',
    voice_chat: 'Talk to the chat or an agent out loud. Needs a speech provider set up on this server.',
    swarm: 'Several AI workers research a question at the same time and combine what they find into one answer.',
    webpages: 'Build web apps with AI, each with its own data, a live preview, versions and publishing.',
    automations: 'Describe a task in chat and the AI builds an automation for it, with triggers, steps in your apps, AI steps and notifications. Test it before it runs.',
    agent_routines: 'Let an agent run a task on a schedule and keep the results in a chat.',
    support_inbox: 'Turn support e-mail into tickets and answer them with an AI agent that knows your knowledge base.',
    app_studio: 'Describe an internal app and the AI builds it: data, screens, forms and access. Adjust it visually and publish it to your organisation or to groups.',
    learning_center: 'Hands-on courses with an AI coach, badges and certificates.',
    learning_custom_content: 'Organisation admins write their own courses for the Learning Center. Needs the Learning Center.',
    compliance_hub_gdpr: 'GDPR, AI Act and ISO 27001 in one place: readiness checks, registers, data subject requests, incidents and audit-ready reports.',
    ai_integration_builder: 'Organisation admins build their own integrations with the help of AI, and grant them like any other integration.',
});

/** The description admins read for a beta: the product text, else the catalogue's. */
export function betaProductDescription(id: string, catalogueDescription: string): string {
    return BETA_PRODUCT_DESCRIPTIONS[id] ?? catalogueDescription;
}

/** A beta's name as the Access screens show it: without a trailing "(Beta)". */
export function betaDisplayName(name: string): string {
    const suffix = ' (Beta)';
    return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/** The name and description of a catalogue beta as the registry projects them. */
export function betaAdminText(beta: { id: string; name: string; description: string }): { name: string; description: string } {
    return { name: betaDisplayName(beta.name), description: betaProductDescription(beta.id, beta.description) };
}
