/**
 * The home screen's welcome headings — ported VERBATIM from the web app's
 * `agent-hub/src/utils/prompts.js` (its WELCOME_MESSAGES; the phone's home
 * has no starter prompts, so the web's other list is not copied).
 *
 * Copied rather than reimagined on purpose: they already carry `starter.*`
 * i18n keys the server's catalogue knows, and they are already the strings a
 * person sees in the browser. A phone that invented its own would be a second
 * thing to translate and a second voice for the same product to speak in.
 *
 * `starter.welcome_5` is "What are we working on?" — the heading a Dutch
 * account renders as "Waar werken we aan?", which is the line in the owner's
 * web screenshot.
 *
 * Keep this file in sync by re-copying, not by editing. If the web's list
 * changes, copy it again.
 */

export interface WelcomeMessage {
    text: string;
    i18nKey: string;
}

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
 * One heading, frozen for the life of the mount: called from
 * `useState(() => pickWelcome())`, so a re-render cannot swap it while
 * somebody is reading it.
 */
export function pickWelcome(): WelcomeMessage {
    return (
        // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- picks which welcome heading to show, nothing secret depends on it
        WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)] ??
        // Not a defensive nicety: noUncheckedIndexedAccess makes the index
        // access `| undefined`, and this is the string the web shows most.
        { text: 'What are we working on?', i18nKey: 'starter.welcome_5' }
    );
}
