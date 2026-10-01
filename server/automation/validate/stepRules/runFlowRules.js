/**
 * The steps that act on the RUN rather than on the data flowing through it:
 * what it puts in front of a person (`notification`, `form_page`), and how it
 * pauses, halts or hands back (`wait`, `stop_error`, `return_to_app`) — plus
 * `note`, the canvas annotation that never runs at all and is bounds-checked
 * here only so an oversized paste is not re-saved on every autosave.
 */

const { isObject, hasText } = require('../helpers');
const {
    NOTIFICATION_STEP_CHANNELS,
    FORM_PAGE_MODES, FORM_PAGE_MIN_WAIT_S, FORM_PAGE_MAX_WAIT_S,
    NOTE_MAX_TEXT_LENGTH, NOTE_MIN_SIZE, NOTE_MAX_SIZE, NOTE_COLOR_KEYS,
    RETURN_TO_APP_REFRESH_MODES, RETURN_TO_APP_ON_ERROR_MODES,
    RETURN_TO_APP_TOAST_TONES, RETURN_TO_APP_MAX_TOAST_CHARS,
    RETURN_TO_APP_MAX_RECORD_REF_CHARS,
} = require('../constants');

function checkNotification(ctx, step, at) {
    const { pushE, pushW } = ctx;
    if (step.type === 'notification') {
        if (!step.title && !step.body) pushE({ code: 'notification.empty', severity: 'error', path: at, message: `Step ${step.id}: notification needs at least \`title\` or \`body\`.`, hint: 'Provide one (or both) so the user has something to read.' });
        // `channels` was never checked, so a "slack" channel (the step form
        // shows slack/push disabled — "coming soon"; AI/JSON authoring does
        // not) sailed through and threw at run time. Mirror what
        // execNotification actually does rather than being stricter than it:
        // it IGNORES unknown channels as long as one known channel survives,
        // and only throws (errorClass notification_channel_unsupported) when
        // none does. So: warn on the ignored ones, error on the fatal case.
        if (step.channels !== undefined && step.channels !== null) {
            if (!Array.isArray(step.channels)) {
                // Not an error: the runner falls back to the in-app bell for
                // any non-array, so a stored `channels: "email"` still runs —
                // it just doesn't do what its author meant.
                pushW({ code: 'notification.channels_shape', severity: 'warning', path: at + '.channels', message: `Step ${step.id}: notification.channels must be an array — it is ignored, so this step only rings the in-app bell.`, hint: `Use an array, e.g. ["notification"] or ["notification", "email"].` });
            } else if (step.channels.length > 0) {
                const unknown = step.channels.filter(c => typeof c !== 'string' || !NOTIFICATION_STEP_CHANNELS.has(c));
                if (unknown.length === step.channels.length) {
                    pushE({ code: 'notification.channels_unsupported', severity: 'error', path: at + '.channels', message: `Step ${step.id}: none of the channels ${unknown.map(c => JSON.stringify(c)).join(', ')} can deliver anything — the run fails here.`, hint: `Use one or more of: ${[...NOTIFICATION_STEP_CHANNELS].join(', ')}.` });
                } else if (unknown.length) {
                    pushW({ code: 'notification.channel_unknown', severity: 'warning', path: at + '.channels', message: `Step ${step.id}: channel ${unknown.map(c => JSON.stringify(c)).join(', ')} is not supported and will be skipped.`, hint: `Only ${[...NOTIFICATION_STEP_CHANNELS].join(', ')} deliver today; remove the others.` });
                }
            }
        }
    }
}

function checkWait(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'wait') {
        const s = step.seconds;
        if (typeof s !== 'number' || s < 1 || s > 86400 || !Number.isFinite(s)) {
            pushE({ code: 'wait.seconds_range', severity: 'error', path: at + '.seconds', message: `Step ${step.id}: wait.seconds must be 1..86400.`, hint: 'Pick a reasonable duration (max 24h).' });
        }
    }
}

function checkStopError(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'stop_error') {
        if (!step.message || !(typeof step.message === 'string' || hasText(step.message))) pushE({ code: 'stop_error.message_missing', severity: 'error', path: at + '.message', message: `Step ${step.id}: stop_error requires \`message\` string.`, hint: 'Surface a human-readable reason for halting the run.' });
    }
}

function checkReturnToApp(ctx, step, at) {
    const { pushE } = ctx;
    /**
     * `return_to_app` — het antwoord dat de app krijgt.
     *
     * Elk veld hier reist als DATA naar een app-runtime in de browser
     * (`_appEffects`), en die runtime kan ouder zijn dan de routine. Een
     * waarde buiten het vocabulaire is daar geen typefout maar een effect
     * dat stil verdwijnt — precies wat deze stap moest voorkomen. Vandaar:
     * het vocabulaire wordt hier GEWEIGERD (integriteit, blokkeert altijd),
     * en "nog niets ingevuld" is een completeness-code die je laat
     * doorbouwen. Onbekend versmalt: liever een rode chip in de editor dan
     * een instructie die de bezoeker nooit ziet.
     */
    if (step.type === 'return_to_app') {
        const nav = step.navigateTo;
        if (nav !== undefined && nav !== null) {
            if (!isObject(nav)) {
                pushE({ code: 'return_to_app.navigateTo_shape', severity: 'error', path: at + '.navigateTo', message: `Step ${step.id}: navigateTo must be an object { screenId, recordRef? }.`, hint: 'Pick a screen in the editor, or remove the field to stay on the current screen.' });
            } else {
                if (typeof nav.screenId !== 'string' || !nav.screenId.trim()) {
                    pushE({ code: 'return_to_app.screen_missing', severity: 'error', path: at + '.navigateTo.screenId', message: `Step ${step.id}: navigateTo has no screen — the app would not know where to go.`, hint: 'Pick the screen the visitor should land on, or remove navigateTo entirely.' });
                }
                if (nav.recordRef !== undefined && nav.recordRef !== null
                    && (typeof nav.recordRef !== 'string' || nav.recordRef.length > RETURN_TO_APP_MAX_RECORD_REF_CHARS)) {
                    pushE({ code: 'return_to_app.record_ref_invalid', severity: 'error', path: at + '.navigateTo.recordRef', message: `Step ${step.id}: navigateTo.recordRef must be a template string of at most ${RETURN_TO_APP_MAX_RECORD_REF_CHARS} characters.`, hint: 'Bind it to the id of the record the next screen should open, e.g. {{steps.save.output.id}}.' });
                }
            }
        }
        const toast = step.toast;
        if (toast !== undefined && toast !== null) {
            if (!isObject(toast)) {
                pushE({ code: 'return_to_app.toast_shape', severity: 'error', path: at + '.toast', message: `Step ${step.id}: toast must be an object { message, tone? }.`, hint: 'Type the message in the editor, or remove the field to say nothing.' });
            } else {
                if (typeof toast.message !== 'string' || !toast.message.trim()) {
                    pushE({ code: 'return_to_app.toast_empty', severity: 'error', path: at + '.toast.message', message: `Step ${step.id}: the toast has no message — the app would show an empty bar.`, hint: 'Write what the visitor should read, or remove the toast.' });
                } else if (toast.message.length > RETURN_TO_APP_MAX_TOAST_CHARS) {
                    pushE({ code: 'return_to_app.toast_too_long', severity: 'error', path: at + '.toast.message', message: `Step ${step.id}: the toast message must be at most ${RETURN_TO_APP_MAX_TOAST_CHARS} characters.`, hint: 'A toast is one line. Put the detail on the screen you send them to.' });
                }
                if (toast.tone !== undefined && toast.tone !== null && !RETURN_TO_APP_TOAST_TONES.has(toast.tone)) {
                    pushE({ code: 'return_to_app.tone_invalid', severity: 'error', path: at + '.toast.tone', message: `Step ${step.id}: unknown toast tone ${JSON.stringify(toast.tone)}.`, hint: `Use one of: ${[...RETURN_TO_APP_TOAST_TONES].join(', ')}.` });
                }
            }
        }
        if (step.refresh !== undefined && step.refresh !== null && !RETURN_TO_APP_REFRESH_MODES.has(step.refresh)) {
            pushE({ code: 'return_to_app.refresh_invalid', severity: 'error', path: at + '.refresh', message: `Step ${step.id}: unknown refresh ${JSON.stringify(step.refresh)}.`, hint: `Use one of: ${[...RETURN_TO_APP_REFRESH_MODES].join(', ')}, or remove the field.` });
        }
        if (step.onError !== undefined && step.onError !== null && !RETURN_TO_APP_ON_ERROR_MODES.has(step.onError)) {
            pushE({ code: 'return_to_app.on_error_invalid', severity: 'error', path: at + '.onError', message: `Step ${step.id}: unknown onError ${JSON.stringify(step.onError)}.`, hint: `Use one of: ${[...RETURN_TO_APP_ON_ERROR_MODES].join(', ')} — what the app does when the return itself cannot be carried out.` });
        }
        // Een terugkeer die niets zegt is niet fout, maar wel onaf: de run
        // eindigt en de bezoeker ziet niets veranderen. Completeness-code —
        // een net gesleepte stap moet blijven opslaan.
        if ((step.navigateTo === undefined || step.navigateTo === null)
            && (step.toast === undefined || step.toast === null)
            && (step.refresh === undefined || step.refresh === null)) {
            pushE({ code: 'return_to_app.empty', severity: 'error', path: at, message: `Step ${step.id}: this step tells the app nothing — no screen, no message, nothing to refresh.`, hint: 'Pick a screen to open, a message to show, or something to refresh.' });
        }
    }
}

function checkNote(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // A canvas annotation (BFSF-411) — bounds-check ONLY. There is
    // deliberately no execution semantic here: `position` is already
    // checked generically for every step/trigger up in validate/graph.js,
    // and execution.js/execFlow.js are what guarantee this step never runs
    // — this block exists purely so an oversized paste or a fat-fingered
    // size doesn't re-save in full on every autosave.
    if (step.type === 'note') {
        if (step.text !== undefined && step.text !== null
            && (typeof step.text !== 'string' || step.text.length > NOTE_MAX_TEXT_LENGTH)) {
            pushE({ code: 'note.text_invalid', severity: 'error', path: at + '.text', message: `Step ${step.id}: a note's text must be at most ${NOTE_MAX_TEXT_LENGTH} characters.`, hint: 'Shorten the note, or split it into two.' });
        }
        if (step.size !== undefined && step.size !== null) {
            if (!isObject(step.size)) {
                pushE({ code: 'note.size_invalid', severity: 'error', path: at + '.size', message: `Step ${step.id}: note.size must be an object { width, height }.`, hint: 'Pass { width: number, height: number } or omit the field entirely.' });
            } else {
                for (const k of ['width', 'height']) {
                    const v = step.size[k];
                    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < NOTE_MIN_SIZE || v > NOTE_MAX_SIZE)) {
                        pushE({ code: 'note.size_invalid', severity: 'error', path: `${at}.size.${k}`, message: `Step ${step.id}: note.size.${k} must be a number between ${NOTE_MIN_SIZE} and ${NOTE_MAX_SIZE}.`, hint: 'Resize the note on the canvas, or fix the value directly.' });
                    }
                }
            }
        }
        // Cosmetic — like edge.color, an unknown value just falls back to
        // the default swatch, so this is a warning, never a blocker.
        if (step.color !== undefined && step.color !== null && !NOTE_COLOR_KEYS.has(step.color)) {
            pushW({ code: 'note.color_unknown', severity: 'warning', path: at + '.color', message: `Step ${step.id}: unknown note colour ${JSON.stringify(step.color)} — the default colour will be used.`, hint: `Use one of: ${[...NOTE_COLOR_KEYS].join(', ')}, or remove the color field.` });
        }
    }
}

function checkFormPage(ctx, step, at) {
    const { pushE, graph, trigger, nested, isContractScope } = ctx;
    if (step.type === 'form_page') {
        const isEnding = step.mode === 'ending';
        if (step.mode !== undefined && !FORM_PAGE_MODES.has(step.mode)) {
            pushE({ code: 'form_page.mode', severity: 'error', path: at + '.mode', message: `Step ${step.id}: mode must be "input" or "ending".`, hint: 'Use "input" to ask the visitor something, "ending" to show a closing summary.' });
        }
        // The nested-in-a-loop/branch rule now lives with the other pause
        // types at the top of checkStep (NESTED_FORBIDDEN_RULES) — same code,
        // same path, same message, so nothing keyed on
        // `form_page.nested_forbidden` changes.
        //
        // A form page is served on the routine's own public form URL. With
        // no form trigger there is no URL and the page can never be shown.
        if (!nested && !isContractScope) {
            const formTriggers = [trigger, ...(Array.isArray(graph.triggers) ? graph.triggers : [])]
                .filter(t => isObject(t) && t.kind === 'form');
            if (formTriggers.length === 0) {
                // BFSF-348 — the message used to open with a raw internal id
                // ("Step step_7c1a: a form step needs…") and stopped at the
                // rule, leaving the reader with no way out of it. Say what is
                // wrong in the user's own vocabulary and put the fix in the
                // hint; the step id stays available in `path` (and at the end
                // of the hint) for the canvas badge mapping. The CODE is
                // unchanged — the frontend keys on it.
                pushE({ code: 'form_page.no_form_trigger', severity: 'error', path: at + '.type', message: 'This step type requires your automation to start with a Form trigger.', hint: `Change the trigger to "Form" so the routine has a public form URL to show this page on, or replace step "${step.id}" with a notification.` });
            }
        }
        // An ending page shows text, so zero fields is normal for it.
        const { validateFormDeclaration } = require('../../formTriggerContract');
        for (const issue of validateFormDeclaration(step.form, { requireFields: !isEnding })) {
            pushE({ code: `form_page.${issue.code}`, severity: 'error', path: `${at}.${issue.path}`, message: `Step ${step.id}: ${issue.message}`, hint: issue.hint });
        }
        if (!isEnding && step.waitSeconds !== undefined) {
            const w = Number(step.waitSeconds);
            if (!Number.isFinite(w) || w < FORM_PAGE_MIN_WAIT_S || w > FORM_PAGE_MAX_WAIT_S) {
                pushE({ code: 'form_page.wait_range', severity: 'error', path: at + '.waitSeconds', message: `Step ${step.id}: waitSeconds must be ${FORM_PAGE_MIN_WAIT_S}..${FORM_PAGE_MAX_WAIT_S} (1 minute … 7 days).`, hint: 'How long the routine waits for the visitor before giving up.' });
            }
        }
    }
}

module.exports = {
    checkNotification, checkWait, checkStopError, checkReturnToApp, checkNote, checkFormPage,
};
