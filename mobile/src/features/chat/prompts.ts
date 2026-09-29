/**
 * Starter prompts and welcome headings — ported VERBATIM from the web app's
 * `agent-hub/src/utils/prompts.js`.
 *
 * Copied rather than reimagined on purpose. These are already Bee-Flow-specific
 * (meetings, knowledge bases, agents, notebooks, automations) rather than
 * generic ChatGPT filler, they already carry `starter.*` i18n keys the server's
 * catalogue knows, and they are already the strings a person sees in the
 * browser. A phone that invented its own would be a second thing to translate
 * and a second voice for the same product to speak in.
 *
 * `starter.welcome_5` is "What are we working on?" — the heading a Dutch
 * account renders as "Waar werken we aan?", which is the line in the owner's
 * web screenshot.
 *
 * Keep this file in sync by re-copying, not by editing. If the web's list
 * changes, copy it again.
 */

export interface StarterPrompt {
    text: string;
    icon: string;
    i18nKey: string;
}

export interface WelcomeMessage {
    text: string;
    i18nKey: string;
}

export const ALL_PROMPTS: StarterPrompt[] = [
    { text: "Summarize my latest meeting notes into action items", icon: "📝", i18nKey: "starter.sp_0" },
    { text: "Draft a project proposal for a new client", icon: "📋", i18nKey: "starter.sp_1" },
    { text: "Help me design an AI agent for customer support", icon: "🤖", i18nKey: "starter.sp_2" },
    { text: "Find the key insights across my knowledge base", icon: "📚", i18nKey: "starter.sp_3" },
    { text: "Write a polished email to a client", icon: "📧", i18nKey: "starter.sp_4" },
    { text: "Plan my week and prioritize my tasks", icon: "📅", i18nKey: "starter.sp_5" },
    { text: "Turn this transcript into a clear summary", icon: "🎙️", i18nKey: "starter.sp_6" },
    { text: "Draft a structured report from my notes", icon: "📊", i18nKey: "starter.sp_7" },
    { text: "Brainstorm ideas for our next team project", icon: "💡", i18nKey: "starter.sp_8" },
    { text: "Help me automate a repetitive workflow", icon: "⚙️", i18nKey: "starter.sp_9" },
    { text: "Write a clear job description for a new role", icon: "💼", i18nKey: "starter.sp_10" },
    { text: "Compare a few options and recommend the best one", icon: "⚖️", i18nKey: "starter.sp_11" },
    { text: "Create a checklist for onboarding a new hire", icon: "✅", i18nKey: "starter.sp_12" },
    { text: "Draft a follow-up message after a meeting", icon: "📨", i18nKey: "starter.sp_13" },
    { text: "Help me prepare for an important meeting", icon: "🤝", i18nKey: "starter.sp_14" },
    { text: "Review this text and suggest improvements", icon: "✍️", i18nKey: "starter.sp_15" },
    { text: "Organize my ideas into a clear outline", icon: "🗂️", i18nKey: "starter.sp_16" },
    { text: "Research a topic and cite the sources", icon: "🔎", i18nKey: "starter.sp_17" },
    { text: "Write the minutes from my meeting notes", icon: "🗒️", i18nKey: "starter.sp_18" },
    { text: "Suggest the next steps for my project", icon: "🚀", i18nKey: "starter.sp_19" },
    { text: "Build a simple webpage for our product", icon: "🌐", i18nKey: "starter.sp_20" },
    { text: "Explain a complex topic to my team simply", icon: "🧩", i18nKey: "starter.sp_21" },
    { text: "Draft an agenda for our team meeting", icon: "📌", i18nKey: "starter.sp_22" },
    { text: "Help me get started with Bee Flow", icon: "🐝", i18nKey: "starter.sp_23" }
];

export const WELCOME_MESSAGES: WelcomeMessage[] = [
    { text: "Where should we start?", i18nKey: "starter.welcome_0" },
    { text: "How can I help you today?", i18nKey: "starter.welcome_1" },
    { text: "What's on your mind?", i18nKey: "starter.welcome_2" },
    { text: "Let's build something great.", i18nKey: "starter.welcome_3" },
    { text: "Ready to explore?", i18nKey: "starter.welcome_4" },
    { text: "What are we working on?", i18nKey: "starter.welcome_5" },
    { text: "Ask me anything.", i18nKey: "starter.welcome_6" },
    { text: "Let's get started.", i18nKey: "starter.welcome_7" },
    { text: "How can I assist you?", i18nKey: "starter.welcome_8" },
    { text: "Need a hand with something?", i18nKey: "starter.welcome_9" }
];

/**
 * `count` prompts, without repeats.
 *
 * Called from `useState(() => pickPrompts(3))` rather than `useMemo`: a re-render
 * must not reshuffle the three rows while somebody is reading them. Fresh on
 * each mount, which is what the web does.
 */
export function pickPrompts(count: number): StarterPrompt[] {
    const pool = [...ALL_PROMPTS];
    const out: StarterPrompt[] = [];
    while (out.length < count && pool.length) {
        out.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
    }
    return out;
}

/** One heading, frozen for the life of the mount for the same reason. */
export function pickWelcome(): WelcomeMessage {
    return (
        WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)] ??
        // Not a defensive nicety: noUncheckedIndexedAccess makes the index
        // access `| undefined`, and this is the string the web shows most.
        { text: 'What are we working on?', i18nKey: 'starter.welcome_5' }
    );
}
