/**
 * What an action is CALLED, in the author's language.
 *
 * This lived inside ActionsSection, so every other place that had to name an
 * action — the data grid's row actions, the repeater's item actions — listed
 * raw ids instead: the user chose between "act_a1b2c3" and "act_d4e5f6" and had
 * to open the Actions accordion to find out which was which. It is a pure
 * function of the definition, so it belongs in its own module rather than
 * inside a 45 KB panel.
 *
 * `titleFor` resolves an automation id to its title; callers without the
 * automations list (the ones outside ActionsSection) pass nothing and get
 * "Run automation" unqualified, which still beats an opaque id.
 */

// `t` is the translate function of the caller; callers that have none get the
// English text, with `{name}` placeholders filled in.
const plainEnglish = (_key, en, params) => (
    params ? en.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : en
);

export function describeAction(id, action, definition, titleFor = null, t = plainEnglish) {
    switch (action?.kind) {
        case 'run_automation': {
            const title = typeof titleFor === 'function' ? titleFor(action.automationId) : null;
            return title
                ? t('studio_apps_insp.labels.run_automation_titled', 'Run automation — {title}', { title })
                : t('studio_apps_insp.labels.run_automation', 'Run automation');
        }
        case 'navigate': {
            const screen = (definition?.screens || []).find((s) => s.id === action.screenId);
            return t('studio_apps_insp.labels.go_to', 'Go to {screen}', {
                screen: screen?.name || t('studio_apps_insp.labels.screen_fallback', 'screen'),
            });
        }
        case 'toast': {
            const msg = (action.message || '').slice(0, 24);
            return msg
                ? t('studio_apps_insp.labels.show_message_with', 'Show a message: “{message}”', { message: msg })
                : t('studio_apps_insp.labels.show_message', 'Show a message');
        }
        case 'open_url':
            return action.url
                ? t('studio_apps_insp.labels.open_url_with', 'Open {url}', { url: action.url })
                : t('studio_apps_insp.labels.open_web_page', 'Open a web page');
        case 'open_modal':
        case 'close_modal': {
            const opening = action.kind === 'open_modal';
            const modal = findModal(definition, action.modalId);
            if (opening) {
                return modal
                    ? t('studio_apps_insp.labels.open_dialog_named', 'Open the “{name}” dialog', { name: modal })
                    : t('studio_apps_insp.labels.open_dialog', 'Open a dialog');
            }
            return modal
                ? t('studio_apps_insp.labels.close_dialog_named', 'Close the “{name}” dialog', { name: modal })
                : t('studio_apps_insp.labels.close_dialog', 'Close a dialog');
        }
        case 'sequence': {
            const n = Array.isArray(action.steps) ? action.steps.length : 0;
            if (!n) return t('studio_apps_insp.labels.flow', 'A flow');
            return n === 1
                ? t('studio_apps_insp.labels.flow_one_step', 'A flow of {count} step', { count: n })
                : t('studio_apps_insp.labels.flow_steps', 'A flow of {count} steps', { count: n });
        }
        case 'send_email':
            return t('studio_apps_insp.labels.send_email', 'Send an e-mail');
        // No table NAME here on purpose: the tables live behind a fetch, not in
        // the definition, so this module cannot resolve one. "Add a row to
        // tbl_7f2a" would be worse than saying less.
        case 'create_record':
            return t('studio_apps_insp.labels.add_row', 'Add a row');
        case 'ai_extract':
            return t('studio_apps_insp.labels.ai_extract', 'AI · extract from document');
        case 'ai_generate':
            return t('studio_apps_insp.labels.ai_generate', 'AI · generate / summarize');
        case 'kb_query':
            return t('studio_apps_insp.labels.ai_kb_query', 'AI · search knowledge base');
        default:
            // An id is a poor label, but it is the only true one for a kind this
            // build does not know — and saying so is better than showing blank.
            return id;
    }
}

/** The title of the modal node with this id, anywhere in the app. */
function findModal(definition, modalId) {
    if (!modalId) return null;
    let found = null;
    const walk = (nodes) => {
        for (const n of nodes || []) {
            if (found) return;
            if (n?.id === modalId && n.type === 'modal') { found = n.props?.title || null; return; }
            if (Array.isArray(n?.children)) walk(n.children);
        }
    };
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return found;
}

/** `[{ id, label }]` for every action in the app — the shape a <select> wants. */
export function actionOptions(definition, titleFor = null, t = undefined) {
    const actions = definition?.actions && typeof definition.actions === 'object' ? definition.actions : {};
    return Object.entries(actions).map(([id, action]) => ({
        id,
        label: describeAction(id, action, definition, titleFor, t),
    }));
}

export default describeAction;
