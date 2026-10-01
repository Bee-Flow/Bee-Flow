/**
 * The phone's half of the i18n guard.
 *
 * `agent-hub/src/i18n/i18nGuard.test.js` walks `agent-hub/src` and nothing
 * else, so every rule it enforces stops at the browser. This file is the same
 * idea pointed at `mobile/`, with the one difference the two clients actually
 * have: the web looks a key up in a bundled dictionary and renders the raw key
 * when it is missing, while `t(key, fallback)` here ALWAYS carries the English
 * literal (see store.ts). A missing key on the phone is therefore invisible —
 * which is why it needs a test rather than a bug report.
 *
 * Two checks.
 *
 * 1. NO HARD-CODED USER-FACING STRING in a converted area. Five shapes, each
 *    one a way a string reaches the screen without passing the catalogue:
 *
 *      <Text>Save</Text>              a JSX text child
 *      title="No chats yet"           a user-facing prop
 *      { title: 'You are offline' }   the same names as object properties,
 *                                     which is where this app keeps the copy
 *                                     it composes before rendering — every
 *                                     error sentence, every menu label, every
 *                                     schedule option
 *      Alert.alert('Delete?', '…')    a system dialog
 *      toast('Task deleted')          the in-app toast
 *
 *    Areas that still carry hard-coded text are on the UNCONVERTED ledger with
 *    their exact count, so an unconverted screen cannot gain strings and a
 *    converted one cannot lose its translation. An area that is on NO ledger
 *    line must be clean — so a new directory starts translated rather than
 *    starting as debt somebody has to notice.
 *
 * 2. EVERY BORROWED KEY EXISTS IN BOTH ENGLISH DICTIONARIES, or is on the
 *    PENDING_KEYS ledger with a reason. The phone reads the SERVER's
 *    catalogue (/api/languages/user/strings/<locale>) and the browser reads
 *    the client's, so a key in only one of them is already broken for
 *    somebody — and on the phone it is broken silently, because the fallback
 *    renders.
 *
 *    "Borrowed" is every key except `mobile.*`. Reusing the web's own key
 *    (`common.cancel`, `settings.appearance`) is the whole point — a string an
 *    administrator has already translated for the browser then appears on the
 *    phone for free — and this check is what stops a rename on that side from
 *    turning the phone silently English.
 *
 *    `mobile.*` is this package's own namespace, per I18N-CONVENTIES §1.3
 *    ("new key in your OWN namespace"), for text that exists nowhere on the
 *    web. It is empty in both dictionaries on purpose: this package may not
 *    append to them (§serieel — they belong to one stage at a time), so those
 *    keys render their English fallback until a stage that owns the
 *    dictionaries lands them. Checking them against the dictionaries would
 *    therefore assert a thing that cannot be true yet, which is why they are
 *    exempt rather than 90 lines of ledger.
 *
 * Related, and deliberately not merged into this file:
 * `src/features/sitemap/nav/sitemap.i18n.test.ts` pins the nineteen keys the
 * sitemap borrows, and says something this cannot — that those nineteen are frozen
 * by an agreement recorded in .claude/handoff/I18N-CONVENTIES.md §1.4. Check 2
 * covers them as a subset; that test says why they may not be renamed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from './dictionaryText';

const HERE = __dirname;
const MOBILE = path.resolve(HERE, '../../..');

/** This package's own namespace. Empty in both dictionaries — see the header. */
const OWN_NAMESPACE = 'mobile';

// ---------------------------------------------------------------------------
// Finding hard-coded text
// ---------------------------------------------------------------------------

/**
 * Text between a `>` and a `</`. Requiring the CLOSING tag is what keeps
 * TypeScript out of the results: `useState<Task | null>(null)` and `=> (` both
 * produce a `>` followed by prose-looking characters, and neither is followed
 * by `</`.
 */
const TEXT_CHILD = />([^<>{}]*[A-Za-z]{2}[^<>{}]*)<\//g;

/**
 * Props that render. Curated rather than "every string prop": `testID`,
 * `name` (an icon), `href`, `key` and the style props are all strings a user
 * never reads, and a guard that flags them is a guard people switch off.
 */
const TEXT_PROPS = [
    'title', 'label', 'placeholder', 'accessibilityLabel', 'accessibilityHint',
    'subtitle', 'message', 'confirmLabel', 'cancelLabel', 'emptyText',
    'helperText', 'description', 'headerTitle', 'submitLabel', 'caption',
    'hint', 'note', 'heading', 'footer', 'actionLabel', 'emptyTitle',
    'shareTitle',
];
const PROP_RX = new RegExp(
    `\\b(${TEXT_PROPS.join('|')})=(["'])([^"']*[A-Za-z]{2}[^"']*)\\2`, 'g',
);

/** Both arguments: Alert.alert renders the title AND the body. */
const ALERT_RX =
    /\bAlert\.alert\(\s*(['"])([^'"]*[A-Za-z]{2}[^'"]*)\1(?:\s*,\s*(['"])([^'"]*[A-Za-z]{2}[^'"]*)\3)?/g;

/** Only the first argument; the second is a tone ('success' | 'error' | …). */
const TOAST_RX = /\btoast\(\s*(['"])([^'"]*[A-Za-z]{2}[^'"]*)\1/g;

/**
 * The same names as OBJECT PROPERTIES. Anchored on `{`, `,` or `(` so a type
 * annotation or a destructure cannot match, and on a string LITERAL so
 * `title: item.name` — data, not copy — cannot either.
 */
const OBJ_RX = new RegExp(
    `(?:^|[{,(]\\s*)(${TEXT_PROPS.join('|')}):\\s*(["'])([^"']*[A-Za-z]{2}[^"']*)\\2`, 'gm',
);

/**
 * Blank out comments before matching, preserving offsets so a future reporter
 * can still point at a line. An example in a doc comment is not a call site —
 * and this package's headers are long and full of quoted UI copy.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1: string) =>
            p1 + ' '.repeat(m.length - p1.length));
}

export interface Finding { kind: string; text: string }

export function findHardCoded(src: string): Finding[] {
    const body = stripComments(src);
    const out: Finding[] = [];
    for (const m of body.matchAll(TEXT_CHILD)) {
        const text = (m[1] ?? '').trim();
        if (text) out.push({ kind: 'jsx-text', text });
    }
    for (const m of body.matchAll(PROP_RX)) {
        out.push({ kind: `prop:${m[1]}`, text: m[3] ?? '' });
    }
    for (const m of body.matchAll(ALERT_RX)) {
        out.push({ kind: 'Alert.alert', text: m[2] ?? '' });
        if (m[4]) out.push({ kind: 'Alert.alert', text: m[4] });
    }
    for (const m of body.matchAll(TOAST_RX)) {
        out.push({ kind: 'toast', text: m[2] ?? '' });
    }
    for (const m of body.matchAll(OBJ_RX)) {
        out.push({ kind: `obj:${m[1]}`, text: m[3] ?? '' });
    }
    return out;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') yield* walk(p);
        } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
            yield p;
        }
    }
}

/**
 * The unit the ledger counts in: a screen folder under `app/`, or a feature
 * under `src/features/`. Small enough that one commit finishes one, big enough
 * that the ledger stays readable.
 */
export function areaOf(rel: string): string {
    const parts = rel.split('/');
    if (parts[0] === 'app') return parts.length > 2 ? `app/${parts[1]}` : 'app/(root)';
    if (parts[0] === 'src' && parts[1] === 'features') return `src/features/${parts[2]}`;
    return `${parts[0]}/${parts[1] ?? ''}`;
}

interface SourceFile { rel: string; area: string; src: string }

function collect(): SourceFile[] {
    const out: SourceFile[] = [];
    for (const root of ['app', 'src']) {
        for (const file of walk(path.join(MOBILE, root))) {
            const rel = path.relative(MOBILE, file).replace(/\\/g, '/');
            out.push({ rel, area: areaOf(rel), src: fs.readFileSync(file, 'utf8') });
        }
    }
    return out;
}

const sources = collect();

// ---------------------------------------------------------------------------
// LEDGER — areas that still render hard-coded English.
//
// A line is a debt with a number on it, not a permission slip: the count is
// exact, so an unconverted screen cannot quietly gain strings, and finishing
// one means deleting its line. "The ledger does not rot" below fails on a line
// whose area is already clean, so this list cannot outlive the debt.
//
// Everything NOT listed must be clean. That is the important direction: a new
// screen folder is born covered, and has to be written through t() rather than
// added here.
// ---------------------------------------------------------------------------
const UNCONVERTED = new Map<string, number>([
    // The mobile restructure (core/shared/features, then one folder per
    // domain with thin routes) moved strings between areas; it did not add
    // any. The total went 1669 -> 1655 only where a duplicated string is now
    // drawn once (shared toasts, QueryScreen headers, content duplicates),
    // and 1655 -> 1649 where dead code went (cowork's unused WHEN_PRESETS).
    ['app/(root)', 1],
    // 24 -> 22: the avatar picker's "Photos not allowed" dialog, gone with the
    // media-library permission the Photo Picker never needed.
    ['src/features/account', 22],
    // 42 -> 33: the conversation list's rename sheet and its actions' toasts went
    // through t() when the long-press menu became the kit's ActionMenu.
    ['src/features/agents', 33],
    // 15 -> 8: the decision's status word, its clock line and its facts went
    // through t() when a deadline stopped reading "Expires: now".
    ['src/features/approvals', 8],
    // 12 -> 5: the form card, its date field and the action's result went
    // through t() with the decimal-comma and run-polling fixes.
    ['src/features/apps', 5],
    // 68 -> 64: the run timeline's empty state and Sent/Received labels and
    // the live card's Stop went through t() with the step names.
    // 64 -> 52: the run facts, the failure cards and the outcome banners went
    // through t() when the trigger and error-class tokens got their words.
    ['src/features/automations', 52],
    // 25 -> 17: the schedule screen's labels and toasts went through t() when
    // its Delete learned to ask first.
    ['src/features/cowork', 17],
    ['src/features/coworkHub', 20],
    ['src/features/documents', 10],
    ['src/features/integrations', 135],
    // 54 -> 49: the add sheet's link door (AddUrlForm) went through t() when
    // it learned to add https:// itself.
    // 49 -> 45: the scanner's camera-off screen went through t() when it
    // learned to open Android's settings.
    // 45 -> 44: the preview's "Open with…", now "Share or save…", which is
    // what the share sheet it opens does.
    ['src/features/knowledge', 44],
    ['src/features/library', 27],
    ['src/features/mcp', 33],
    ['src/features/memory', 24],
    // 34 -> 33: the row body's "Tap to read the full result", with the reauth
    // note that now names the connector.
    ['src/features/notifications', 33],
    ['src/features/org', 73],
    ['src/features/recording', 98],
    ['src/features/search', 9],
    ['src/features/security', 30],
    ['src/features/settings', 21],
    // Not new debt: the sitemap's destination labels and hints, moved out of
    // features/shell (98) when the drawer replaced the More tab. The shell
    // itself is now clean, and the move left 16 fewer strings than it took.
    // +16, two literals (label and hint) per new row: src/meta/routes.test.ts
    // requires a sitemap row for every screen, and a row has no other
    // spelling. PR4b added eight: Datatables, Studio Documents, Playbooks,
    // Runs & log and the four Meeting Notes tools. The same PR took 110
    // strings off other lines (webpages and projects cleared, recording
    // 125 -> 100, documents 16 -> 10), so the ledger as a whole fell.
    // +2: the App Studio coming-soon row (label and hint; the web has no key
    // for either).
    ['src/features/sitemap', 100],

    // 33 -> 30: the self-help group (its heading and two rows) went through t()
    // when "What changed recently" moved to the native release notes.
    ['src/features/support', 30],
    // 40 -> 38: the task sheet's actions and toasts went through t() when its
    // Delete learned to ask first.
    ['src/features/tasks', 38],
    // 16 -> 13: the template chat's words, when it learned to avoid the keyboard.
    ['src/features/templates', 13],
    ['src/features/voice', 8],
]);

/**
 * KEY LEDGER — keys the phone asks for that are not in both dictionaries.
 *
 * Every entry renders its English fallback today, so nothing looks broken; it
 * is simply untranslatable, which on a privacy product sold into Dutch
 * organisations is a visible defect rather than a cosmetic one. They are
 * listed rather than fixed here because the two dictionaries belong to one
 * stage at a time (I18N-CONVENTIES §serieel) and `mobile/` may not append to
 * them. Landing a key = deleting its line; "the ledger does not rot" fails on
 * a line that is no longer needed.
 */
const PENDING_KEYS = new Map<string, string>([
    ['starter.welcome_2', 'client only; the phone reads the SERVER catalogue, so this suggestion is always English'],
    ['starter.welcome_3', 'client only; same'],
    ['starter.welcome_7', 'client only; same'],
]);

/**
 * SAME WORDS, OWN KEY — `mobile.*` fallbacks whose English is already a web
 * sentence in one of the namespaces the phone borrows from, in both
 * dictionaries. A `mobile.*` key renders English for ever (see the header),
 * while the web's is translated, so a phone sentence that means what a web
 * key means borrows that key. The entries below match in their ENGLISH only:
 * the same word with another job, which a translator may well render
 * differently, or a page-specific key a generic label should not lean on.
 */
const BORROWABLE_NAMESPACES = /^(routines|routine_editor|forms|common)\./;
const PAGE_SPECIFIC_RETRY = "the web's 'Try again' keys belong to one page each (forms studio, answers, a table row); there is no generic one";
const PAGE_SPECIFIC_REQUIRED = "the web's 'Required' is a column of the extraction and table-row editors, not a field's chip";
const PAGE_SPECIFIC_ADVANCED = "the web's 'Advanced' key is the Return-to-app editor's own section";
const OTHER_REMOVE = "forms.share.audience_remove takes a person off an audience; these remove a question or a row";
const OTHER_DONE = "routines.card.badge_done is a run's status badge; this 'done' closes an edit";
const OTHER_TODAY = "the answers dashboard's KPI and range words; these are a date answer's shortcut";
const OTHER_STOP = "routines.node.stop_error.typeLabel names the step that stops a run with an error; this 'Stop' is a button";
const LOOP_PORT_DONE = "routines.canvas.loop_port_done names a loop's exit port; this 'Done' closes a sheet";
const OTHER_SETTINGS = "the web's 'Settings' keys are tabs of the form page and the step editor, not a screen's title";
const OTHER_SHARE = "forms.page.tab_share is the form page's own tab";
const BUILDER_WORD = 'routines.builder.*_word is a word spliced into one builder sentence';
const RANGE_NOT_LIFETIME = "the answers dashboard's date ranges; these are a public link's lifetime";
// The builder redesign's routines.versions.*, routines.ribbon.* and friends
// (2026-09-28) say many short words for the first time.
const VERSION_SETTING = "routines.versions.setting.* names a step's setting in the version compare; this is a field of something else";
const OTHER_OPEN = "routines.agent_step.open_agent opens the agent an agent step runs; there is no generic 'Open'";
const OTHER_RENAME = "routines.versions.rename renames a saved version; this renames something else";
const OTHER_COPIED = "routines.settings.webhook_copied confirms a copied webhook address; there is no generic 'Copied'";
const OTHER_MORE = "routines.ribbon.more is the step ribbon's overflow pill; this opens a screen's own menu";
const OTHER_CHANGE = "routines.sharing.change_pill changes who a routine is shared with; this changes a trigger or a page's audience";
const OTHER_STEPS = "routines.ribbon's 'Steps' heads the step ribbon's search results and category; this heads another list of steps";
const OTHER_ICON = "routines.settings.icon is the routine settings' own field";
const OTHER_SHOW_ALL = "routines.output.show_all shows every column of a step's output table";
const OTHER_OPTIONS = "routines.mismatch.options_generic heads the mapping mismatch resolver's choices; this heads a field's own options";
const OTHER_DISCARD = "routines.assistant.discard throws away the assistant's proposal or plan; this discards something else";
const OTHER_DOCUMENTS = "routines.ribbon.data_documents is a row of the step ribbon, and documents.title heads Studio Documents; this is the knowledge documents";
const SAME_WORDS_OWN_KEY = new Map<string, string>([
    ['mobile.error.retry', PAGE_SPECIFIC_RETRY],
    ['mobile.flow.retry.tries', PAGE_SPECIFIC_RETRY],
    ['mobile.flow.save.retry', PAGE_SPECIFIC_RETRY],
    ['mobile.flow.field.required', PAGE_SPECIFIC_REQUIRED],
    ['mobile.flow.form.required', PAGE_SPECIFIC_REQUIRED],
    ['mobile.flow.form.advanced', PAGE_SPECIFIC_ADVANCED],
    ['mobile.flow.section.advanced', PAGE_SPECIFIC_ADVANCED],
    ['mobile.flow.form.remove_question', OTHER_REMOVE],
    ['mobile.flow.row.remove', OTHER_REMOVE],
    ['mobile.flow.list.done', OTHER_DONE],
    ['mobile.flow.set.done', OTHER_DONE],
    ['mobile.forms.fill.today', OTHER_TODAY],
    ['mobile.apps.date_today', OTHER_TODAY],
    ['mobile.flow.ai.stop', OTHER_STOP],
    ['mobile.flow.run.stop', OTHER_STOP],
    ['mobile.automations.live.stop', OTHER_STOP],
    ['mobile.flow.code.code', "the Code step's section holding its source, not the step type's name"],
    ['mobile.markdown.code', "routines.node.code.* names the Code step; this heads a code block that names no language"],
    ['mobile.flow.datatable.table', "routines.mapping.table is the mapping panel's table view, not the table a step writes to"],
    ['mobile.flow.datatable.value', 'routines.builder.value_word is a word spliced into one builder sentence'],
    ['mobile.flow.http.response', "forms.answers.drawer_title is a form's response; this is an HTTP response"],
    ['mobile.flow.http.shared_with_you', "forms.page.readonly_chip marks a read-only form; this marks a shared connection"],
    ['mobile.flow.save.pending', "forms.page.unsaved_title heads the form page's leave dialog; this is a save status"],
    ['mobile.flow.settings.title', "the web's 'Settings' keys are tabs of other pages; the routine settings screen has none"],
    ['mobile.flow.status_live', "forms.status.live is a form's status, not a routine's"],
    ['mobile.automations.fact.finished', "routines.runs.finished is a run's outcome sentence; this labels the time a run finished"],
    ['mobile.billing.custom_plan', "forms.answers.range_custom is a custom date range; this names a subscription whose plan has no name"],
    ['mobile.datatables.done', LOOP_PORT_DONE],
    ['mobile.datatables.required', PAGE_SPECIFIC_REQUIRED],
    ['mobile.datatables.step_n', "routines.canvas.row_step numbers a canvas row; this counts an import's steps"],
    ['mobile.onboarding.share', "forms.page.tab_share is the form page's own tab; this hands a recovery key to the system share sheet"],
    ['mobile.org.preset_custom', "forms.answers.range_custom is a custom date range; this is a custom theme preset"],
    ['mobile.org.shield_active', "routines.active is a routine's state; this is the Privacy Shield's"],
    ['mobile.org.shield_required', PAGE_SPECIFIC_REQUIRED],
    ['mobile.playbooks.open_run', "forms.answers.drawer_open_run opens the run behind a form answer; this opens a playbook run"],
    ['mobile.projects.leave', "forms.page.unsaved_leave leaves an unsaved form page; this leaves a project"],
    ['mobile.recording.pause', "routines.pause pauses a routine; this pauses audio playback"],
    ['mobile.studio_documents.block.text', BUILDER_WORD],
    ['mobile.studio_documents.done', LOOP_PORT_DONE],
    ['mobile.studio_documents.param.text', BUILDER_WORD],
    ['mobile.studio_documents.rule.value', BUILDER_WORD],
    ['mobile.studio_documents.tab.text', BUILDER_WORD],
    ['mobile.studio_documents.type.presentation', "routines.node.presentation.* names the Presentation step; this is a document type"],
    ['mobile.webpages.data.integration', "routines.node.integration_action.defaultLabel names a step; this is a kind of data source"],
    ['mobile.webpages.data.revoke', "forms.share.audience_remove takes a person off an audience; this revokes a page's data grant"],
    ['mobile.webpages.link.done', LOOP_PORT_DONE],
    ['mobile.webpages.link.last_viewed', "forms.studio.last_submission dates a form's last answer; this dates a link's last view"],
    ['mobile.webpages.link.new', "forms.share.link_rotate replaces a form's only link; this adds another share link"],
    ['mobile.webpages.link.refresh', "forms.answers.refresh reloads a form's answers; this refreshes a share link"],
    ['mobile.webpages.link.share', OTHER_SHARE],
    ['mobile.webpages.link.state_live', "forms.status.live is a form's status, not a share link's"],
    ['mobile.webpages.public.expiry_30', RANGE_NOT_LIFETIME],
    ['mobile.webpages.public.expiry_7', RANGE_NOT_LIFETIME],
    ['mobile.webpages.source.add_text', BUILDER_WORD],
    ['mobile.webpages.source.add_text_title', "routines.builder.add_text adds a text part to a binding; this adds a text source"],
    ['mobile.webpages.source.retry', "routine_editor.run_retry and routines.ndv.retry retry a test run; this retries a source"],
    ['mobile.webpages.source.text', BUILDER_WORD],
    ['mobile.webpages.tab.settings', OTHER_SETTINGS],
    ['mobile.webpages.tab.share', OTHER_SHARE],
    ['mobile.flow.action.open', OTHER_OPEN],
    ['mobile.flow.approval.groups', "routines.library.blockGroups says a library step is shared with groups; this heads the groups in a directory"],
    ['mobile.flow.condition.test', "routines.header.test is the builder's Test menu; this labels a condition's comparison"],
    ['mobile.flow.fill.instructions', VERSION_SETTING],
    ['mobile.flow.form.message', VERSION_SETTING],
    ['mobile.flow.form.rename', OTHER_RENAME],
    ['mobile.flow.loop.loop', "routines.ndv.family.loop names a family of step types; this heads a loop's own settings"],
    ['mobile.flow.more', OTHER_MORE],
    ['mobile.flow.ndv.symbol_default', "routines.library.default badges the default way to create a routine; this resets a symbol"],
    ['mobile.flow.rename', OTHER_RENAME],
    ['mobile.flow.set.hide', "routines.output.hide folds an output table's technical columns; this hides a JSON extract"],
    ['mobile.flow.set.rename', OTHER_RENAME],
    ['mobile.flow.settings.editor', "routines.header.view_editor names the builder's canvas view; this heads the device's editor preferences"],
    ['mobile.flow.status_draft', "routines.header.step_draft and routines.library.blockDraft are a library step's state; the web's routine state word has no key"],
    ['mobile.flow.tab_steps', OTHER_STEPS],
    ['mobile.flow.versions.not_saved', "routines.templates.orgEmptyTitle is the template gallery's empty state; this is a routine never saved"],
    ['mobile.flow.view', "routines.sharing.view_pill says a routine is shared read-only; this switches the editor's view"],
    ['mobile.approvals.fact_routine',"routines.versions.routineRow heads the version compare's routine row; this names the routine an approval came from"],
    ['mobile.automations.change', OTHER_CHANGE],
    ['mobile.automations.open', OTHER_OPEN],
    ['mobile.automations.rename', OTHER_RENAME],
    ['mobile.chat.attach_document', VERSION_SETTING],
    ['mobile.chat.copied', OTHER_COPIED],
    ['mobile.chat.details.save_name', "routines.versions.saveName names a saved version; this names a conversation"],
    ['mobile.chat.skill_count', "routines.*_skills_plural are the plural halves of an AI step's skill count; this counts a chat's skills"],
    ['mobile.chat.trace_steps', OTHER_STEPS],
    ['mobile.compliance.check_history', "routines.versions.history is a routine's version history; this is a compliance check's"],
    ['mobile.forms.fill.copied', OTHER_COPIED],
    ['mobile.forms.fill.untitled', VERSION_SETTING],
    ['mobile.forms.more', OTHER_MORE],
    ['mobile.kb_documents.title', OTHER_DOCUMENTS],
    ['mobile.knowledge.tab_documents', OTHER_DOCUMENTS],
    ['mobile.markdown.copied', OTHER_COPIED],
    ['mobile.markdown.test_steps', OTHER_STEPS],
    ['mobile.nav.organisation_logo', "routines.library.blockOrg says a library step is shared with the organisation; this stands in for its name"],
    ['mobile.notifications.empty_show_all', OTHER_SHOW_ALL],
    ['mobile.onboarding.pending_title', "routines.ndv.pill_waiting is a step waiting on an approver; this is an account waiting on an administrator"],
    ['mobile.playbooks.more', OTHER_MORE],
    ['mobile.projects.field_icon', OTHER_ICON],
    ['mobile.projects.field_instructions', VERSION_SETTING],
    ['mobile.recording.clear_filters', "routines.overview.clearFilters belongs to the routines overview; this clears the meeting library's"],
    ['mobile.recording.import_skipped', "routines.repeating.logSkipped is a scan log's outcome; this is a recording import's"],
    ['mobile.runs.filter.range', "routines.notify.when heads when a notification fires; this is a date range"],
    ['mobile.settings.address', VERSION_SETTING],
    ['mobile.settings.connection', "routines.output.setting_connection names the connection a step failed on; this is HTTP or HTTPS"],
    ['mobile.settings.switch_server', "routines.ndv.action_switch switches a step's action; this switches servers"],
    ['mobile.skills.icon', OTHER_ICON],
    ['mobile.skills.open', OTHER_OPEN],
    ['mobile.skills.save_failed', "routines.header.save_failed is the routine builder's save state; this is a skill's"],
    ['mobile.studio.attention_show_all', OTHER_SHOW_ALL],
    ['mobile.studio_documents.open', OTHER_OPEN],
    ['mobile.studio_documents.outline.ph_title', VERSION_SETTING],
    ['mobile.studio_documents.param.example', "routines.notify.example heads a notification's example message"],
    ['mobile.studio_documents.rename', OTHER_RENAME],
    ['mobile.studio_documents.section.title', VERSION_SETTING],
    ['mobile.studio_documents.tab.templates', "routines.templates.title heads the routine template gallery"],
    ['mobile.ui.stepper_more', OTHER_MORE],
    ['mobile.usage.range_days', "routines.settings.retention_days is how long runs are kept; this is a usage range"],
    ['mobile.webpages.link.open', OTHER_OPEN],
    ['mobile.webpages.link.revoke', "routines.settings.webhook_revoke revokes a webhook; this revokes a share link"],
    ['mobile.webpages.public.change', OTHER_CHANGE],
    ['mobile.webpages.settings.bases', VERSION_SETTING],
    ['mobile.webpages.settings.icon', OTHER_ICON],
    // The builder's work modes (2026-10) say 'Apply', 'Discard' and 'Options' for the first time.
    ['mobile.datatables.options', OTHER_OPTIONS],
    ['mobile.flow.section.options', OTHER_OPTIONS],
    ['mobile.flow.json.apply', "routines.assistant.apply applies the assistant's proposal; this applies a step's hand-edited JSON"],
    ['mobile.ui.discard', OTHER_DISCARD],
    ['mobile.webpages.versions.source_published', "routines' 'Published' is a library step's state; this says a publish made the version (the web's own word for that is 'Publish')"],
]);

// ---------------------------------------------------------------------------
// The dictionaries
// ---------------------------------------------------------------------------

// Both dictionaries are read as text by ./dictionaryText (shared with
// sitemap.i18n.test.ts).

const client = readDict(CLIENT_DICT);
const server = readDict(SERVER_DICT);

/** `t('key', 'English')` and the `i18nKey:` carriers that travel as data. */
const KEY_RX = /\bt\(\s*(['"])([a-z0-9_]+(?:[.\-][a-z0-9_.\-]*[a-z0-9_])+)\1/g;
const DATA_KEY_RX = /\bi18nKey:\s*(['"])([a-z0-9_]+(?:[.\-][a-z0-9_.\-]*[a-z0-9_])+)\1/g;

function keysInUse(): Map<string, string> {
    const out = new Map<string, string>();
    for (const { rel, src } of sources) {
        for (const re of [KEY_RX, DATA_KEY_RX]) {
            for (const m of src.matchAll(re)) {
                const key = m[2] as string;
                if (!out.has(key)) out.set(key, rel);
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------

describe('the mobile tree is readable at all', () => {
    it('found the screens and both dictionaries', () => {
        // Without this every check below could pass by walking nothing.
        expect(sources.length).toBeGreaterThan(150);
        expect(client.size).toBeGreaterThan(5000);
        expect(server.size).toBeGreaterThan(5000);
    });
});

describe('no hard-coded user-facing text outside the ledger', () => {
    const byArea = new Map<string, Finding[]>();
    const whereByArea = new Map<string, Map<string, number>>();
    for (const { rel, area, src } of sources) {
        const found = findHardCoded(src);
        if (!byArea.has(area)) byArea.set(area, []);
        (byArea.get(area) as Finding[]).push(...found);
        if (found.length) {
            if (!whereByArea.has(area)) whereByArea.set(area, new Map());
            (whereByArea.get(area) as Map<string, number>).set(rel, found.length);
        }
    }

    const areas = [...byArea.keys()].sort();

    it.each(areas.filter((a) => !UNCONVERTED.has(a)))(
        '%s renders every string through t()',
        (area) => {
            const found = byArea.get(area) ?? [];
            const detail = found
                .slice(0, 12)
                .map((f) => `  [${f.kind}] ${f.text}`)
                .join('\n');
            expect(
                `${area}: ${found.length} hard-coded string(s)\n${detail}`,
            ).toBe(`${area}: 0 hard-coded string(s)\n`);
        },
    );

    it.each([...UNCONVERTED.keys()].sort())(
        '%s is still on the ledger, at exactly the recorded count',
        (area) => {
            const actual = (byArea.get(area) ?? []).length;
            const recorded = UNCONVERTED.get(area) as number;
            // Equality, not "<=": the number is the debt, and a number that is
            // allowed to be stale stops being a measurement.
            expect({ area, actual }).toEqual({ area, actual: recorded });
        },
    );

    it('the ledger does not rot', () => {
        const done = [...UNCONVERTED.keys()].filter((a) => (byArea.get(a) ?? []).length === 0);
        expect({ areasToRemoveFromTheLedger: done }).toEqual({ areasToRemoveFromTheLedger: [] });

        const unknown = [...UNCONVERTED.keys()].filter((a) => !byArea.has(a));
        expect({ areasThatNoLongerExist: unknown }).toEqual({ areasThatNoLongerExist: [] });
    });
});

describe('every key the phone borrows still exists on the other side', () => {
    const inUse = keysInUse();
    const borrowed = [...inUse.keys()].filter((k) => !k.startsWith(`${OWN_NAMESPACE}.`)).sort();
    const own = [...inUse.keys()].filter((k) => k.startsWith(`${OWN_NAMESPACE}.`)).sort();

    it('reads keys at all', () => {
        expect(inUse.size).toBeGreaterThan(3);
        expect(borrowed.length).toBeGreaterThan(3);
    });

    it.each(borrowed.map((k) => [k, inUse.get(k) as string]))(
        '%s (%s) is in both English dictionaries',
        (key, where) => {
            if (PENDING_KEYS.has(key)) return;
            expect({ key, where, client: client.has(key), server: server.has(key) })
                .toEqual({ key, where, client: true, server: true });
        },
    );

    it('the key ledger does not rot', () => {
        const landed = [...PENDING_KEYS.keys()].filter((k) => client.has(k) && server.has(k));
        expect({ keysToRemoveFromTheLedger: landed }).toEqual({ keysToRemoveFromTheLedger: [] });

        const gone = [...PENDING_KEYS.keys()].filter((k) => !inUse.has(k));
        expect({ keysNoLongerUsed: gone }).toEqual({ keysNoLongerUsed: [] });
    });

    it(`${OWN_NAMESPACE}.* keys are shaped like keys`, () => {
        // Not checked against the dictionaries — see the header. What IS worth
        // pinning is the shape, because a key that reads like a sentence is a
        // key somebody typed into the wrong argument, and `t()` would then
        // render the FALLBACK of a key that can never be filled.
        const malformed = own.filter((k) => !/^mobile\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(k));
        expect({ malformed }).toEqual({ malformed: [] });
    });
});

describe('a phone sentence that means a web sentence borrows its key', () => {
    /** `t('mobile.…', 'English')` and translate(), with the fallback as written. */
    const FALLBACK_RX = /\b(?:t|translate)\(\s*'(mobile\.[a-z0-9_.]+)',\s*'((?:[^'\\]|\\.)*)'/g;
    const unescape = (text: string) => text.replace(/\\(.)/g, '$1');
    const webSentences = new Set<string>();
    for (const [key, value] of client) {
        if (BORROWABLE_NAMESPACES.test(key) && server.get(key) === value) webSentences.add(unescape(value));
    }
    const repeats = new Map<string, string>();
    for (const { rel, src } of sources) {
        for (const m of src.matchAll(FALLBACK_RX)) {
            const key = m[1] as string;
            if (webSentences.has(unescape(m[2] ?? '')) && !repeats.has(key)) repeats.set(key, rel);
        }
    }

    it('every other mobile.* sentence the web already says uses the web’s key', () => {
        const unlisted = [...repeats].filter(([key]) => !SAME_WORDS_OWN_KEY.has(key)).map(([key, where]) => `${key} (${where})`);
        expect({ borrowTheWebKeyFor: unlisted.sort() }).toEqual({ borrowTheWebKeyFor: [] });
    });

    it('the same-words ledger does not rot', () => {
        const gone = [...SAME_WORDS_OWN_KEY.keys()].filter((key) => !repeats.has(key));
        expect({ keysToRemoveFromTheLedger: gone }).toEqual({ keysToRemoveFromTheLedger: [] });
    });
});
