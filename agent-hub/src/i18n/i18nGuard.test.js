/**
 * i18n completeness guard.
 *
 * Prevents the "raw key rendered in the UI" bug class:
 *  1. Every literal t('key') call site must have its key in EN_DEFAULTS —
 *     t() returns the RAW KEY for a missing key with no string 2nd arg.
 *  2. The `t('key') || 'Fallback'` idiom is banned: t() returns the truthy
 *     raw key, so the || never fires. Use t('key', 'Fallback') instead.
 *  3. The client dict (en-defaults.js) and the server source dict
 *     (server/i18n/defaults/en/*.js) must have identical KEY sets, so every
 *     string is translatable in the admin Languages panel and renders even
 *     when the API is unreachable.
 *  4. Dynamic keys (template literals / string concat) can't be checked
 *     exactly — instead each dynamic prefix must match at least one
 *     EN_DEFAULTS key, catching renamed/typo'd namespaces.
 *  5. Keys that travel as DATA (`labelKey:` properties, local tr() shims)
 *     get the same check — the EN fallback beside them hides a missing key
 *     forever, which is how eleven mismatch keys shipped untranslatable.
 *     In the App-definition zone the very same property names select a FIELD
 *     ON A ROW, so there the rule FLIPS instead of lifting: an unknown value
 *     is an ordinary field path, a value that IS a dictionary key is the bug.
 *     See FIELD_SELECTOR_FILES.
 *  6. HELPER MODULES that compose sentences get the same check in all four
 *     shapes they use: a key as a helper ARGUMENT (`nOf(t, 'k', n)`), a bare
 *     `key:` in a `{ key, en }` table, a t() ALIAS (`tt(`, `_t(`,
 *     `tRef.current(`), and — for the registered ones — an English sentence
 *     with NO key beside it at all.
 *     The helper-argument half is found by COUNTING brackets (keyArgCalls
 *     below), not by matching them with a regex. A regex cannot: the argument
 *     list of `_isoMutate(setBusy, id, () => fetchJson(`${API}/…/${encode(x)}/
 *     attest`, {…}), refresh, 'compliance.…', 'Fallback')` nests two levels
 *     deep, and every depth a pattern is widened to reach is one more depth it
 *     still stops at. Measured over the tree: the old `([^()]*)` saw 147 call
 *     sites, a one-level `((?:[^()]|\([^()]*\))*)` 157, counting 163 — and the
 *     six the middle one misses are exactly the six heaviest, all in
 *     components/admin/compliance/index.jsx.
 *  7. The two dictionaries must agree on VALUES, not only on key sets: a key
 *     whose English differs makes the offline fallback say something else
 *     than the server does. Since the client copy is generated this holds by
 *     construction — the check catches a hand edit the --check step missed.
 *  8. The helper REGISTER is discovered, not remembered: a new `.js`/`.ts`
 *     module of a shape that keeps being copy-pasted (a relative-time
 *     formatter, a `*_LABELS` table of English) has to join TEXT_HELPERS, so
 *     the debt count can only be right. Without it the register only ever
 *     shrank — the rot check catches a helper that disappears, never one that
 *     arrives.
 *
 * Keys that a check finds but neither dictionary defines yet live in
 * PENDING_KEYS below — a written-down debt, not a silent pass.
 *
 * ===========================================================================
 * THE ONE RULE TO READ BEFORE ADDING A KEY: ONE WRITER PER NAMESPACE FILE
 * ===========================================================================
 *
 * The English dictionary is `server/i18n/defaults/en/<namespace>.js`, one
 * file per namespace (the part of a key before the first "."), merged by
 * `en/index.js`. `agent-hub/src/i18n/en-defaults.js` is GENERATED from it —
 * never edit it by hand; after changing server/i18n/defaults/en/*, run
 *
 *     node scripts/gen-i18n-defaults.mjs
 *
 * and commit both. CI fails when the generated copy is out of date
 * (`--check`), and `scripts/i18n-key-guard.mjs` fails a pull request that
 * loses a key its base had.
 *
 * Why the files are split, and why the rule is still "one writer": two
 * writers appending to the same tail do not produce a conflict git shows you —
 * they produce a merge in which THE SECOND WINS AND THE FIRST ONE'S KEYS ARE
 * GONE. Until 2026-09-24 both dictionaries were single ~16,000-line files that
 * everyone appended to, so every stage collided with every other. Now two
 * branches only collide when they write the SAME namespace file, so ONLY ONE
 * STAGE AT A TIME MAY WRITE TO A GIVEN NAMESPACE FILE. The generated copy
 * never needs merging by hand: take either side and regenerate.
 *
 * So, in practice:
 *  - Not the writer of that namespace file right now? Do not add keys there.
 *    Write them down: as a line on PENDING_KEYS below when they travel as
 *    data, or in the hand-off for the stage that does have the turn.
 *  - With the turn: edit the namespace file, run the generator, commit both
 *    in the SAME commit (the key sets and the English values must stay
 *    identical — checks 3 and 7), and rebase-then-append.
 *  - A key you delete on purpose goes on
 *    server/i18n/defaults/removed-keys.txt, or the key guard fails the PR.
 *  - A new namespace is a new file: create en/<namespace>.js and list it in
 *    en/index.js (which throws on an unlisted file, on a key filed under the
 *    wrong namespace, and on a key defined twice).
 *  - Plural is a KEY choice, never a string choice: base key + `<key>_plural`,
 *    built by `pluralKey()`/`nOf()` (KnowledgeStudio/plural.js). Never
 *    `problem${n === 1 ? '' : 's'}` — that is English grammar in JavaScript
 *    and no translation can undo it.
 *  - A namespace follows the SUBJECT, not the screen, and has one writer.
 *    Need someone else's namespace? Reuse the key if it exists, ask its owner
 *    if the text is theirs, otherwise put a new key in your OWN namespace.
 *
 * Nineteen keys are FROZEN: `sidebar.*` and `settings.*` feed the More tab of
 * the Expo app through `mobile/src/features/settings/sitemap.ts`, which this
 * guard never sees. Adding is fine; renaming or deleting one makes the phone
 * silently English — no crash, no red test. Touch one, change sitemap.ts in
 * the same commit.
 *
 * These rules come from the 2026-09-06 i18n conventions document, an internal
 * note that is not part of this repository. (Comments elsewhere in this file
 * cite it by section — §2.3 plural, §4.2 the helper register; the rule each
 * section sets is spelled out where it is cited.)
 *
 * THE OTHER DIRECTION lives outside this file. Every check here starts from a
 * key; none of them can see a sentence on screen that has no key at all. That
 * is `scripts/i18n-ratchet.mjs` — a ratchet over JSX text nodes and the
 * placeholder/title/aria-label/alt attributes, budget in
 * `agent-hub/.i18n-ratchet.json`, run with
 * `node scripts/i18n-ratchet.mjs agent-hub`. Its header documents what counts
 * as user-facing and why.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import EN_DEFAULTS from './en-defaults';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const SERVER_DEFAULTS = path.resolve(HERE, '../../../server/i18n/defaults/en.js');
// The source text of the server dictionary: one file per namespace, merged by
// index.js (which is not a dictionary file itself).
const SERVER_DICT_DIR = path.resolve(HERE, '../../../server/i18n/defaults/en');
const SERVER_NAMESPACE_FILES = fs.readdirSync(SERVER_DICT_DIR)
    .filter(f => f.endsWith('.js') && f !== 'index.js').sort();

// Files whose t() mentions are not real call sites.
const EXCLUDED = new Set([
    'hooks/useTranslation.tsx', // JSDoc usage examples
]);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(p);
        else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) yield p;
    }
}

function collectSources() {
    const out = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).replace(/\\/g, '/');
        if (rel.startsWith('i18n/') || EXCLUDED.has(rel)) continue;
        out.push({ rel, src: fs.readFileSync(file, 'utf8') });
    }
    return out;
}

const sources = collectSources();
const sourceOf = (rel) => sources.find(s => s.rel === rel);

// ---------------------------------------------------------------------------
// Shared vocabulary for the data/helper checks. At module scope on purpose:
// the describe callbacks below stay well under the function-size cap
// (eslint.config.js: max-lines-per-function 80) only because the lists live
// out here.
// ---------------------------------------------------------------------------

// A translation key as it reads in source. The hyphen is deliberate: the whole
// `learn.*` family (learn.cowork-basics.*, learn.effective-prompts.*, …) — 248
// keys — spells its segments with one, and a pattern without `-` skips every
// carrier and shim that names a lesson.
const KEY = '[a-z0-9_]+(?:[.\\-][a-z0-9_.\\-]*[a-z0-9_])+';
const KEYISH_RX = new RegExp(`(['"])${KEY}\\1`);

/**
 * DEBT LEDGER — keys the checks below find in the tree that neither dictionary
 * defines yet. They render their English fallback today, so nothing looks
 * broken; they are simply untranslatable in the Languages panel.
 *
 * They are listed rather than added because the two dictionaries belong to one
 * stage at a time (the one-writer rule at the top of this file): two writers
 * appending to a 7166-key file means the second rebase wins and drops the
 * first one's keys. Landing a key = deleting its line here — "the ledger does
 * not rot" below fails on an entry that is no longer needed, so this list
 * cannot outlive the debt.
 *
 * The ledger applies ONLY to keys carried as data. Every entry has an English
 * fallback sitting beside it in the source, which is exactly why they shipped
 * unnoticed. A literal `t('key')` has no fallback, so that check stays strict.
 */
const PENDING_KEYS = new Map([
    // LEEG, en dat is de bedoeling. Track Z heeft alle 34 posten ingelost: de 24
    // startsuggesties uit utils/prompts.js, de vijf notebooks-sleutels van de
    // mkTt-shim, de drie dlp.blocked_attachment_*-teksten uit sseEvents.js,
    // automations.kind.choice en compliance.audit_toast_failed. Alle 34 staan nu in
    // BEIDE woordenboeken; "the ledgers and registers do not rot" hieronder viel
    // rood zodra ze landden, en dat is precies hoe deze lijst hoort te werken.
    //
    // Een nieuwe post hoort hier alleen te staan zolang de sleutel als DATA
    // reist (een fallback naast zich heeft in de bron) en de stage die hem
    // schrijft de woordenboeken niet mag aanraken. Landen = de regel hier weer
    // weghalen.
]);

/** Known to the product: in the dictionary, or on the ledger above. */
const known = (key) => key in EN_DEFAULTS || PENDING_KEYS.has(key);

/**
 * VALUE DRIFT LEDGER — keys both dictionaries define with DIFFERENT English.
 * Same debt shape, same reason for not fixing it here (the dictionaries are
 * one stage's at a time). Until then the user reads one sentence offline and
 * another one online.
 */
const PENDING_VALUE_DRIFT = new Set([
    // Empty since 2026-09-24, when en-defaults.js became GENERATED from the
    // server dictionary (scripts/gen-i18n-defaults.mjs). The last five were
    // settled then: azure.thinking_budget ("Thinking Effort") and
    // notebooks.placeholder ("Start writing, or generate a document from your
    // sources…") took the client's wording, which the curriculum facts
    // confirm; signup.choose_auth_carefully_desc,
    // compliance.checks.gdpr_art32_eit.fix and compliance.checks.gdpr_art44.desc
    // kept the server's. A key only lands here again through a hand edit of the
    // generated file, which CI's --check step already refuses.
]);

// Properties that carry a translation key. Allow-list, not pattern:
// `dataKey`/`sortKey`/`configKey`-style properties carry field names.
// Adding a new carrier property? Add its name here too.
//
// FOUR OF THESE NAMES ARE OVERLOADED. In a Studio App definition,
// `titleKey`/`labelKey`/`badgeKey`/`descriptionKey` are the FIELD on a row to
// display — `row?.[titleKey]`, set from the inspector's "Title field" box —
// and the field is a path, so `titleKey: 'contact.full-name'` is an ordinary
// value there and key-shaped to the eye. Same spelling, opposite meaning; the
// zone where the meaning flips is listed in FIELD_SELECTOR_FILES below.
const CARRIERS = [
    'labelKey', 'titleKey', 'descKey', 'bodyKey', 'nameKey', 'tKey',
    'phKey', 'hintKey', 'shortKey', 'explainKey', 'badgeKey', 'actionHintKey',
    'objectiveKey', 'remediationKey', 'descriptionKey', 'bodyMdKey',
    'questionKey', 'instructionKey', 'i18nKey',
    // Lesson content (BFSF-474): quiz choice feedback and explanation, sim
    // pair sides and note, sim scenario brief — the generator emits these
    // beside their English fallbacks in onboarding/generated/lessons.js.
    'feedbackKey', 'explanationKey', 'leftKey', 'rightKey', 'noteKey', 'briefKey',
];

/**
 * The App-definition zone: files holding component `props` for a Studio App,
 * where a CARRIERS name selects a data field instead of naming a key. A field
 * name is a path, so `titleKey: 'contact.full-name'` is an ordinary value here
 * and key-shaped to the eye — a key that does not exist and cannot be added.
 *
 * The zone does not SKIP the carrier check, it TURNS IT AROUND. Skipping bought
 * nothing: every value in these three files is one word (`'title'`, `'tag'`,
 * `'owner'`, `'label'`, `'filename'`), which no key pattern matches, so the
 * skip exempted zero hits and cost three files their carrier coverage — and no
 * rot check could ever say so, since `titleKey: 'title'` satisfies "still has a
 * carrier property" forever.
 *
 * Inside the zone the mistake worth catching is the opposite one: a value that
 * IS a key the product knows. That is a translation key riding in a field
 * selector — invisible to the Languages panel and one inspector edit away from
 * being read as a column name. Give it a name of its own. An unknown key-shaped
 * value stays fine here: that is what a nested field name looks like.
 *
 * The boundary runs through AppStudio, not around it: the editor chrome
 * (`editor/ComponentRibbon.jsx` — `labelKey: 'app_studio.palette.chip_button'`)
 * carries real keys and is checked the normal way. Only the definition, sample
 * and fixture files flip.
 */
const FIELD_SELECTOR_FILES = [
    'components/admin/Studio/AppStudio/runtime/componentRegistry.jsx',
    'components/admin/Studio/AppStudio/state/sampleDefinitions.js',
    'demo/fixtures/appStudio.js',
];

// t() under another name. `\bt(` does not match any of these — the character
// before the call is a word character — so both the key check and the
// `|| fallback` ban walked straight past 184 call sites.
const T_ALIASES = ['tr', 'tt', '_t'];
const ALIAS_CALL = `(?:^|[^\\w$.])(${T_ALIASES.join('|')})\\(|\\btRef\\.current\\(`;

// Helpers that take a key as an ARGUMENT instead of calling t() themselves —
// no `t(` pattern can see those. Allow-list with the position deliberately
// unspecified: the check reads every key-shaped literal in the call, because
// the key sits 2nd in nOf(), 3rd in nameOf() and 5th in _isoMutate().
const KEY_ARG_HELPERS = ['tx', 'nOf', 'pluralKey', 'nameOf', '_isoMutate'];
// Of those, the two that DERIVE a second key at runtime: `<key>_plural`
// (KnowledgeStudio/plural.js). That derived key exists nowhere as a literal,
// so it is the one key shape no regex over the tree can otherwise reach.
const PLURAL_DERIVING = new Set(['nOf', 'pluralKey']);

/**
 * The index of the bracket that closes the `open` at `from`, or -1 when the
 * count never returns to 0 — a truncated file, or a quoting shape endOfQuoted
 * misreads. Returning -1 rather than "the rest of the file" is what keeps a
 * miscount local: one call is dropped instead of swallowing everything after
 * it as its own argument list.
 *
 * Quotes and backticks are skipped whole, so a bracket inside a string or a
 * `{n}` placeholder cannot move the counter.
 */
function closingBracket(src, from, open, close) {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
        const c = src[i];
        if (c === "'" || c === '"' || c === '`') i = endOfQuoted(src, i);
        else if (c === open) depth++;
        else if (c === close && --depth === 0) return i;
    }
    return -1;
}

/** The closing quote of the literal opening at `at` (end of file if unclosed). */
function endOfQuoted(src, at) {
    for (let i = at + 1; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === src[at]) return i;
    }
    return src.length;
}

/**
 * Every `helper(…)` call in `src`, with the ARGUMENT TEXT between its own
 * brackets. Found by counting, because the argument list is a nesting language
 * and a regex is not: `[^()]*` cannot cross a single `(`, and the widened
 * `(?:[^()]|\([^()]*\))*` from the plan cannot cross two. That is not a corner
 * case — the eight `_isoMutate(` calls in
 * components/admin/compliance/index.jsx pass an arrow that calls fetchJson()
 * with a template holding `${encodeURIComponent(userId)}`, two levels down,
 * and the key whose miss actually matters sits AFTER that argument. Measured:
 * 147 call sites with `[^()]*`, 157 one level wider, 163 counting; of the
 * eight `_isoMutate(` calls the old pattern saw exactly one (the unnested one
 * on line 497).
 *
 * Comments are NOT stripped first, on purpose. Two hits come from the docblock
 * in components/agents/AgentStudio/AgentCard.jsx that describes this very gap
 * (`nOf(filling(t), …)` / `nOf(t, 'key', …)`); neither holds a key-shaped
 * literal, so both are inert, and running the tree through the deliberately
 * naive stripComments() would risk its `//` rule cutting into a string and
 * unbalancing the count — which fails SILENT (see below), the one failure mode
 * a guard must not have.
 *
 * Quotes and backticks are skipped whole so a bracket inside a string cannot
 * move the counter. If the counter never returns to 0 — a truncated file, or a
 * string shape the skip misreads — that ONE call is dropped rather than
 * swallowing the rest of the file as its arguments.
 *
 * Pure and at module scope so the fixture test below can run source text
 * through the same code path the tree does.
 */
function keyArgCalls(src, helpers = KEY_ARG_HELPERS) {
    const OPEN = new RegExp(`\\b(${helpers.join('|')})\\(`, 'g');
    return [...src.matchAll(OPEN)].flatMap((m) => {
        const from = m.index + m[0].length - 1; // the helper's own `(`
        const end = closingBracket(src, from, '(', ')');
        if (end === -1) return []; // unbalanced: drop this call, not the file
        return [{ fn: m[1], args: src.slice(from + 1, end), index: m.index }];
    });
}

/**
 * The keys a helper call hands over that the product does not know — including
 * the `_plural` half the PLURAL_DERIVING helpers build at runtime. Pure for the
 * same reason keyArgCalls is: the test that proves the counting works feeds it
 * a fixture instead of the tree.
 */
function unknownArgKeys(rel, src) {
    const LIT = new RegExp(`(['"])(${KEY})\\1`, 'g');
    return keyArgCalls(src).flatMap(({ fn, args }) => [...args.matchAll(LIT)].flatMap(([, , key]) => [
        ...(known(key) ? [] : [`${rel}: ${fn}(… '${key}')`]),
        ...(PLURAL_DERIVING.has(fn) && !known(`${key}_plural`) ? [`${rel}: ${fn}('${key}') derives ${key}_plural`] : []),
    ]));
}

/**
 * The `key:` values in a `{ key, en }` table that the product does not know.
 * `srcOf` is injected so the fixture test can prove it is the LIST that bites:
 * the same fixture source reported when its name is on the list, silent when
 * it is not.
 */
function unknownTableKeys(rels, srcOf) {
    const RX = new RegExp(`\\bkey:\\s*(['"])(${KEY})\\1`, 'g');
    return rels.flatMap((rel) => [...(srcOf(rel) || '').matchAll(RX)]
        .filter(m => !known(m[2])).map(m => `${rel}: key: ${m[2]}`));
}

// Files where a bare `key:` property carries a translation key — the
// `{ key, en }` table shape. An allow-list is unavoidable: elsewhere `key:`
// holds React list keys, node ids and localStorage names (`new-chat`,
// `my-organization`, `sample-a`).
const KEY_TABLE_FILES = [
    'components/admin/Studio/Executions/runLanguage.js',
    'components/admin/Studio/KnowledgeStudio/SourceDetail.jsx',
    'components/admin/Studio/KnowledgeStudio/freshness.js',
    'components/admin/Studio/KnowledgeStudio/sourceKinds.js',
    // Seven event labels in EVENT_LABELS. Reported by P5's own adversarial
    // round: the file uses the { key, en } shape but was not on this list, so
    // those keys travelled unchecked — an `en` beside a key is exactly what
    // hides a missing one, which is the reason this check exists.
    'components/admin/Studio/AppStudio/inspector/ActionsSection.jsx',
    'components/admin/Studio/SkillsStudio/SkillStepEditor.jsx',
    'components/admin/Studio/SkillsStudio/SkillsOverview.jsx',
    // De statustabellen van de ISMS-registers (AUDIT_STATUS, FINDING_SEVERITY,
    // NC_STATUS, NC_SEVERITY, NC_SOURCE, OBJ_STATUS) — de opvolger van de
    // { key, en }-tabellen uit de oude AuditPage.jsx.
    'components/admin/compliance/pages/audits/auditForms.js',
    // The access log's event labels (ACTION_META), moved out of
    // AccessAuditPage.jsx. The same { key, en } shape has slipped past the
    // guard four times (labelKey in O4 and W5, the studio.ai.err_* table in
    // H4, and the Notebooks chart modal); a new file with that shape belongs
    // on this list straight away.
    'components/admin/compliance/pages/accessAuditLabels.ts',
    // The Overview's deadline kinds and empty-register lines (KIND_LABEL in
    // DeadlinesCard, EMPTY_LINE in deadlineRows) and the phone's home tabs
    // (HOME_TABS in ComplianceMobile).
    'components/admin/compliance/pages/overview/DeadlinesCard.jsx',
    'components/admin/compliance/pages/overview/deadlineRows.ts',
    'components/admin/compliance/ComplianceMobile.jsx',
    // OBLIGATION_KINDS — de soorten opleidingsverplichting.
    'components/admin/compliance/pages/TrainingPage.jsx',
    // LEGAL_BASES, RESIDENCY, NIS2_ENTITY_CLASSES, CRA_ROLES,
    // CONFORMANCE_LEVELS, RELEVANCE_OPTIONS: de keuzelijsten van het
    // instellingenformulier reizen als DATA.
    'components/admin/compliance/pages/settings/settingsFields.js',
    'components/automation/Builder/flow/nodeTypeColors.js',
    // Vier tabellen in het spoorpaneel (A4 deel C): regelkoppen, de reden dat
    // een stap ontbreekt, de weggelaten feiten en de fasenamen. Ze reizen als
    // DATA — `line(tt, entry)` roept t() met een variabele aan — dus geen enkele
    // andere controle hier ziet ze.
    'components/chat/AnswerTracePanel.jsx',
    'components/automation/Builder/mapping/fieldKinds.js',
    // The automations launcher's tab labels (TABS).
    'components/admin/Studio/AutomationsStudio/AutomationsLauncher.jsx',
    'components/skills/SkillFormModal.jsx',
    // De vier filterkoppen van de skills-grid (`{ id, key, en }`, gerenderd als
    // `{t(f.key, f.en)}`). Precies de bewaakte vorm, en tot nu toe niet op deze
    // lijst: een verzonnen sleutel in die tabel liet de guard groen.
    'components/skills/SkillsGrid.jsx',
    // De vier grafiektypen van de notitieblok-editor. Hier heette `key` eerst
    // het CHARTTYPE ('bar'|'line'|…) en stond het label er kaal naast; de tabel
    // is naar `{ id, key, en }` gebracht zodat `key` weer een sleutel is.
    'editor/react/ChartConfigModal.jsx',
    'pages/settings/usage/OverviewTab.jsx',
    'pages/settings/usage/RangeControl.jsx',
];

/**
 * REGISTER of helper modules whose job is to compose user-facing text. These
 * have no JSX and often no t() at all, so every other check is blind to them —
 * and the sentences they return are what the runs list, the Cowork list and
 * every project row actually print.
 *
 * `pending:` means the module still returns bare English. That is real debt
 * owned by a screen stage (KRITIEK #30, "tijd- en statusformattering"), not an
 * exemption: the check asserts a pending module is still dirty, so the stage
 * that cleans one has to take it off this list in the same commit.
 *
 * The list is NOT hand-maintained any more. "the register does not undercount"
 * below re-derives it from the tree for the two shapes that keep being
 * copy-pasted (HELPER_SHAPES), so a new copy joins it or the guard goes red.
 * It was written by hand once, and by the next read of the tree it named four
 * pending files where nineteen modules had the shape — the count is the thing
 * a stage plans against, so an undercount is worse than a long list.
 */
const TEXT_HELPERS = [
    { rel: 'components/shared/statusTokens.ts' },
    { rel: 'components/admin/Studio/KnowledgeStudio/freshness.js' },
    { rel: 'components/admin/Studio/KnowledgeStudio/plural.js' },
    { rel: 'components/automation/Builder/mapping/mismatch.js' },
    // The clock: ten modules, eight of them the very same ladder — "just now",
    // "{n}m ago", "{n}h ago" — pasted from each other and already drifting
    // (`Math.round` here, `Math.floor` there, "just now" vs "Just now"). The
    // translated one already exists: hooks/useRelativeTime.ts, whose four
    // keys are in BOTH dictionaries, so this cluster can be cleaned without a
    // dictionary turn. Only the pure modules need a t-taking variant.
    { rel: 'components/cowork/coworkFormat.js', pending: 'CW — relativeTime/formatDuration/fullTimestamp, plus the browser locale' },
    { rel: 'components/projects/relativeTime.js', pending: 'PRJ — the same five sentences, copied' },
    { rel: 'components/admin/Studio/AutomationsStudio/historyUtils.js', pending: 'RUN — times, durations, expiry and the day buckets' },
    { rel: 'components/automation/taskFormatters.js', pending: 'ROU — timeAgo/formatNextRun, plus the hard REPEAT_OPTIONS table' },
    { rel: 'pages/meeting-notes/lib/format.js', pending: 'MTG — the same ladder again' },
    { rel: 'utils/helpers.js', pending: 'shared — "Just now" (capital J: the copy that drifted) and the demo notices' },
    { rel: 'utils/dateFormatters.ts', pending: 'shared — durations and byte sizes; the unit suffix is copy too' },
    { rel: 'pages/settings/usage/format.js', pending: 'USE — billing-period ranges, browser locale' },
    { rel: 'components/cowork/coworkSchedule.js', pending: 'CW — "Run now" / "In an hour" / "Tomorrow morning" presets' },
    // Registered CLEAN, with no pending: every English string in its two
    // tables is a fallback beside a key (`admin.shield_activity_action_*`,
    // `admin.shield_activity_marker_*`, both in the dictionaries), which is
    // what the rest of this list is working towards. It is on the register
    // because the SHAPE keeps getting copy-pasted, not because it owes
    // anything.
    { rel: 'components/admin/security/guardrails/orgShield/activity/activityLabels.js' },
    // Label tables: value → English, no key anywhere. Same shape as the two in
    // runLanguage.js that this register was built around.
    { rel: 'components/automation/Builder/flow/triggerLabels.js', pending: 'BLD — TRIGGER_TYPE_LABEL/TRIGGER_NAME/APP_EVENT_TYPE_LABEL, read by four Builder files' },
    { rel: 'components/admin/Studio/AppStudio/rbac/rowRuleModel.js' },
    { rel: 'components/admin/Studio/Datatables/datatableDisplay.js', pending: 'DT — visibility sentences and GRADE_LABEL' },
    { rel: 'components/admin/Studio/SupportStudio/auditMeta.js', pending: 'SUP — ACTION_LABEL, the whole ticket audit trail' },
    { rel: 'components/admin/ai-config/ProviderCards/local/localRuntimeApi.js', pending: 'A1 — TIER_LABELS plus the runtime error messages' },
    { rel: 'components/admin/ai-config/chatModelTiers/modelMeta.js', pending: 'A1 — EFFORT_LABELS and the openAIEffortOptions labels' },
    { rel: 'components/admin/product-website/analytics/filters.js', pending: 'CMS — analytics filter names' },
    { rel: 'components/admin/product-website/analytics/heatmap/model.js', pending: 'CMS — block-type names in the heatmap' },
    // Caught by the relative-time signature on the words "just now" in a
    // sentence that is not about time at all — which is the check doing its
    // job by accident and landing on real debt anyway. The two sentences here
    // are what the Condition node says when its AI fallback could not be
    // reached, and they are English because the whole Suggest-outputs box is:
    // RouteAssist.jsx beside it takes no `t`, exactly like the branch-family
    // node cards it sits among. Registered as one entry rather than reworded
    // around the regex, because rewording is the escape this register's own
    // header calls out.
    { rel: 'components/automation/Builder/flow/settings/routeRulesRequest.js', pending: 'BLD — the AI-fallback refusals; the rest of the Suggest-outputs box is English too' },
];

/**
 * Blank out comments so a JSDoc example ("t(key, en, params)") is not read as
 * a sentence the UI prints. Line counts are preserved. Deliberately naive —
 * it only ever runs over the hand-picked register above.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

/**
 * Class lists and CSS values. They have to be subtracted explicitly, because
 * by the plain test they read as prose — a Tailwind class list has spaces and
 * long words, so a colour map would count as untranslated copy and its file
 * could never come off the pending list however well it was cleaned.
 */
const TECHNICAL_RX = new RegExp([
    'var\\(--', '[[\\]<>]', '://', '_srgb',
    '\\b(?:hsl|hsla|rgb|rgba|calc|minmax|linear-gradient|url)\\(',                     // CSS values
    '(?:^|\\s)(?:dark|hover|focus|active|disabled|group-hover|sm|md|lg|xl):[a-z[-]',   // Tailwind variants
    '(?:^|\\s)(?:bg|text|border|ring|shadow|from|via|to)-[a-z]+-\\d{2,3}\\b',          // Tailwind utilities
].join('|'));

/**
 * `${…}` is JavaScript, not text, so it is removed before the value is judged.
 * The spaces and words inside `${pad(d.getMonth() + 1)}` are an expression;
 * counting them made two machine values read as English — the `…T${pad(h)}:…`
 * that fills an <input type="datetime-local"> and `${Math.round(ms / 1000)}s` —
 * and those files could then never have come off the pending list, however well
 * they were cleaned, which is exactly the debt this register exists to
 * schedule. `${mins}m ago` survives as "m ago"; `${bytes} B` correctly does not.
 */
const EXPR_RX = /\$\{[^{}]*\}/g;

/**
 * A word no translator can do anything with: an identifier or a machine
 * keyword. A value made only of those is input for a machine, not copy —
 * `SORT_LABELS = { recent: 'created_at desc' }` is an ORDER BY — and the same
 * subtraction as the Tailwind one above, for the same reason: without it a
 * table of sort expressions counts as untranslated English purely because its
 * constant is spelled `*_LABELS`, and the only ways out are renaming the
 * constant or writing down debt that does not exist.
 */
const MACHINE_WORD_RX = /^(?:[a-z0-9]+[_:.][a-z0-9_:.]*|asc|desc|null|true|false|undefined)$/i;
const ORDER_BY_RX = /^[\w.]+\s+(?:asc|desc)$/i;

/**
 * A string value a person would read: has a space, a word, and none of the
 * three shapes above in it — a class list, an expression, a machine value.
 * All three read as prose by the plain test, and every one of them left a file
 * permanently "dirty" for something no translator could ever have translated.
 */
const isProse = (raw) => {
    const v = raw.replace(EXPR_RX, '').trim();
    if (!/ /.test(v) || !/[A-Za-z]{3,}/.test(v) || TECHNICAL_RX.test(v)) return false;
    return !(ORDER_BY_RX.test(v) || v.split(/\s+/).every(w => MACHINE_WORD_RX.test(w)));
};

/**
 * A per-file exemption list still describing the tree: the file must exist,
 * and — when the list was given a shape — must still contain the shape it was
 * exempted for. Three lists want exactly this, and the second half is the half
 * that matters: a list pointing at a file that has lost its shape covers
 * whatever has since moved in.
 */
function listRot(label, rels, shapeRx, shape) {
    return rels.flatMap((rel) => {
        const src = sourceOf(rel)?.src;
        if (src === undefined) return [`GONE — remove ${rel} from ${label}`];
        if (shapeRx && !shapeRx.test(src)) return [`NO ${shape} LEFT — remove ${rel} from ${label}`];
        return [];
    });
}

/**
 * Every prose value a module hands back with NO key beside it — "beside" being
 * the same line or the three above, which is how the house shapes write it
 * (`key:` then `en:`, `labelKey` then `labelEn`). A key inside that window
 * means the English is a fallback and the Languages panel can reach it.
 *
 * Shared by the register check and the shape scan below on purpose: the scan
 * decides which files must be registered, the register asserts a pending file
 * is still dirty, and if the two disagreed about "dirty" a file could be
 * required and rejected at the same time.
 */
const VALUE_RX = /(?:\breturn\s+|[:?]\s*)(['"`])((?:[^'"`\\\n]|\\.)*?)\1/g;
function bareProse(rel) {
    const src = stripComments(sourceOf(rel)?.src || '');
    const lines = src.split('\n');
    const out = [];
    let idx = 0;
    let ln = 1;
    for (const m of src.matchAll(VALUE_RX)) {
        for (; idx < m.index; idx++) if (src.charCodeAt(idx) === 10) ln++;
        if (!isProse(m[2])) continue;
        if (lines.slice(Math.max(0, ln - 4), ln).some(l => KEYISH_RX.test(l))) continue;
        out.push(`${rel}:${ln} ${JSON.stringify(m[2])}`);
    }
    return out;
}

/**
 * The `{ … }` that opens at `from` — string-aware through closingBracket, so a
 * `{n}` placeholder inside a value cannot unbalance the count. An unclosed
 * brace yields the rest of the file, which is what the callers want to judge.
 */
function braceBlock(src, from) {
    const end = closingBracket(src, from, '{', '}');
    return end === -1 ? src.slice(from) : src.slice(from, end + 1);
}

/**
 * The shapes that keep coming back. Both are ordinary, useful code — the point
 * is only that a module of this shape composes English the Languages panel
 * cannot reach, so it belongs on the register above.
 *
 * Deliberately two narrow signatures rather than "any module with a sentence
 * in it": that broader question matches 156 files and 1963 strings, most of
 * them demo content, Tailwind classes and country names, and a register nobody
 * can maintain exempts more than it catches.
 *
 * The label table is read by its VALUES, not by its name. `X_LABELS = {` says
 * nothing about what is in the braces — a sort table (`{ recent: 'created_at
 * desc' }`) or a cache-key map answers to that name too, and a check triggered
 * by a naming convention leaves an author two escapes, both wrong: rename the
 * constant, or register debt that does not exist and then swear it stays dirty
 * forever. So the table has to hold at least one value that reads as English.
 */
const LABEL_TABLE_RX = /\b[A-Z][A-Z0-9_]*_LABELS?\b\s*=\s*\{/g;
const HELPER_SHAPES = [
    {
        what: 'a relative-time formatter',
        has: (code) => /\bjust now\b|\$\{[^}]*\}\s*[mhdws]? ?ago\b|\b(?:Today|Tomorrow|Yesterday) at\b/i.test(code),
    },
    {
        what: 'a *_LABEL(S) table of English',
        has: (code) => [...code.matchAll(LABEL_TABLE_RX)].some((m) => {
            const body = braceBlock(code, m.index + m[0].length - 1);
            return [...body.matchAll(VALUE_RX)].some(v => isProse(v[2]));
        }),
    },
];

// Trees the shape scan skips. `demo/` is seeded CONTENT — invented customers,
// invented tickets — and one of those ticket bodies says "just now" inside the
// sentence a fake colleague wrote. Demo content is a demo question, not an
// i18n one.
const HELPER_SCAN_SKIP = ['demo/'];

describe('i18n guard', () => {
    it('every literal t(key) call site has its key in EN_DEFAULTS', () => {
        // First arg is a string literal immediately followed by `,` or `)`
        // (a following `+` or backtick means a dynamic key — checked below).
        const CALL_RX = /\bt\(\s*(['"])((?:[^'"\\]|\\.)+?)\1\s*[,)]/g;
        const missing = [];
        for (const { rel, src } of sources) {
            for (const m of src.matchAll(CALL_RX)) {
                const key = m[2];
                if (!/^[\w.-]+$/.test(key)) continue; // not a translation key
                if (!(key in EN_DEFAULTS)) missing.push(`${rel}: ${key}`);
            }
        }
        expect(missing, `t() keys missing from en-defaults.js — add them to server/i18n/defaults/en/<namespace>.js and run node scripts/gen-i18n-defaults.mjs:\n${missing.join('\n')}`).toEqual([]);
    });

    it('the broken `t(key) || fallback` idiom is not used', () => {
        const ANTI_RX = /\bt\(\s*(['"])[^'"]+?\1\s*\)\s*\|\|/g;
        const hits = [];
        for (const { rel, src } of sources) {
            for (const m of src.matchAll(ANTI_RX)) {
                const line = src.slice(0, m.index).split('\n').length;
                hits.push(`${rel}:${line}`);
            }
        }
        expect(hits, `t() returns the raw key when missing, so "|| fallback" never fires. Use t('key', 'Fallback') instead:\n${hits.join('\n')}`).toEqual([]);
    });

    it('client and server default dictionaries have identical key sets', () => {
        const require_ = createRequire(import.meta.url);
        const { GUI_DEFAULTS } = require_(SERVER_DEFAULTS);
        const client = new Set(Object.keys(EN_DEFAULTS));
        const server = new Set(Object.keys(GUI_DEFAULTS));
        const clientOnly = [...client].filter(k => !server.has(k));
        const serverOnly = [...server].filter(k => !client.has(k));
        expect(clientOnly, `keys in en-defaults.js but missing from server/i18n/defaults/en/ (untranslatable in the Languages panel):\n${clientOnly.join('\n')}`).toEqual([]);
        expect(serverOnly, `keys in server/i18n/defaults/en/ but missing from en-defaults.js (no offline English fallback) — run node scripts/gen-i18n-defaults.mjs:\n${serverOnly.join('\n')}`).toEqual([]);
    });

    it('neither dictionary defines the same key twice', () => {
        // The key-set check above compares the PARSED objects, so it is blind
        // to this: a duplicated key is silently collapsed by the JS object
        // literal, last one wins, and the earlier entry becomes dead code that
        // still looks editable. Both files had this — 37 keys in the client
        // (`pii.api_key_or_secret` three times) and 13 in the server — so an
        // edit to the first `pii.*` block changed nothing at all and the two
        // dictionaries still passed the parity check.
        //
        // Read the SOURCE, since that is the only place a duplicate exists.
        // The server side is one file per namespace (en/index.js throws on a
        // key found in two of them), so a duplicate can only hide INSIDE one.
        const files = [
            ['en-defaults.js', path.join(HERE, 'en-defaults.js')],
            ...SERVER_NAMESPACE_FILES.map(f => [`server/i18n/defaults/en/${f}`, path.join(SERVER_DICT_DIR, f)]),
        ];
        expect(SERVER_NAMESPACE_FILES.length, 'no namespace files found under server/i18n/defaults/en/').toBeGreaterThan(50);
        for (const [label, file] of files) {
            const src = fs.readFileSync(file, 'utf8');
            const seen = new Map();
            const dups = [];
            const re = /^\s*(['"])([A-Za-z0-9_.\-]+)\1\s*:/gm;
            let m;
            // Line numbers are tracked incrementally. The obvious version —
            // `src.slice(0, m.index).split('\n').length` per match — copies and
            // splits the whole file for EVERY key, which is quadratic: at ~5000
            // keys over a 300KB dictionary it is hundreds of millions of
            // characters of work, and this test began timing out at 5s under a
            // parallel run purely from adding keys. Same numbers, linear cost.
            let lastIndex = 0;
            let line = 1;
            while ((m = re.exec(src)) !== null) {
                const key = m[2];
                for (let i = lastIndex; i < m.index; i++) {
                    if (src.charCodeAt(i) === 10) line++;
                }
                lastIndex = m.index;
                if (seen.has(key)) dups.push(`${key} (lines ${seen.get(key)} and ${line})`);
                else seen.set(key, line);
            }
            expect(dups, `${label} defines these keys more than once. The later value wins and the earlier one is dead — editing it has no effect:\n${dups.join('\n')}`).toEqual([]);
        }
    });

    it('dynamic t(`…${x}…`) key prefixes match at least one EN_DEFAULTS key', () => {
        const DYN_RX = /\bt\(\s*`([^`$]*)\$\{/g;
        const CONCAT_RX = /\bt\(\s*(['"])((?:[^'"\\]|\\.)+?)\1\s*\+/g;
        const allKeys = Object.keys(EN_DEFAULTS);
        const bad = [];
        for (const { rel, src } of sources) {
            const prefixes = [
                ...[...src.matchAll(DYN_RX)].map(m => m[1]),
                ...[...src.matchAll(CONCAT_RX)].map(m => m[2]),
            ];
            for (const prefix of prefixes) {
                if (!prefix || prefix.length < 3) continue; // too generic to check
                if (!allKeys.some(k => k.startsWith(prefix))) bad.push(`${rel}: t(\`${prefix}…\`)`);
            }
        }
        expect(bad, `dynamic key prefixes with NO matching EN_DEFAULTS keys (typo or missing entries):\n${bad.join('\n')}`).toEqual([]);
    });
});

// Keys that travel as DATA instead of literal t() calls. Separate describe so
// neither callback outgrows the function-size cap.
describe('i18n guard — keys carried as data', () => {
    it('every *Key: property names a real key — and none in the field-selector zone does', () => {
        // The gap that let eleven `automations.mismatch.*` keys ship without an
        // English entry: a component that stores its keys as data
        // (`labelKey: 'x.y', labelEn: 'Fallback'`) and calls t() with a
        // variable never matches the literal-call check above. The EN fallback
        // makes the screen look fine, so nothing fails — but the key is
        // untranslatable in the Languages panel, and Dutch is impossible.
        //
        // The CARRIERS allow-list and the key pattern both live at module
        // scope — the list because it is the convention (add a carrier
        // property, add its name there), the pattern because a key spelled
        // with a hyphen is still a key. In FIELD_SELECTOR_FILES the same
        // property names point at a column, so the question flips there: not
        // "is this key known" but "is this field name a key" — the one reading
        // that cannot be a coincidence, and the rule the zone's whole existence
        // depends on.
        const RX = new RegExp(`\\b(${CARRIERS.join('|')}):\\s*(['"])(${KEY})\\2`, 'g');
        const missing = [];
        const misplaced = [];
        for (const { rel, src } of sources) {
            const zone = FIELD_SELECTOR_FILES.includes(rel);
            for (const m of src.matchAll(RX)) {
                const hit = `${rel}: ${m[1]}: ${m[3]}`;
                if (zone && known(m[3])) misplaced.push(hit);
                else if (!zone && !known(m[3])) missing.push(hit);
            }
        }
        expect(missing, `carrier properties naming keys missing from en-defaults.js — add them to server/i18n/defaults/en/<namespace>.js and run node scripts/gen-i18n-defaults.mjs, or put them on PENDING_KEYS:\n${missing.join('\n')}`).toEqual([]);
        expect(misplaced, `a translation key travelling in a field-selector property. Inside FIELD_SELECTOR_FILES a *Key prop names a COLUMN — rename the property (or move the text out of the definition), because nothing translates it here:\n${misplaced.join('\n')}`).toEqual([]);
    });

    it('every t() alias call site (tr/tt/_t/tRef.current) names a real key', () => {
        // Local shims exist so pure modules can run without a t() in scope
        // (`tr` in mismatch.js/fieldKinds.js), so a toolbar can translate with
        // a fallback (`mkTt` in editor/react/toolbarPrimitives.jsx), or so an
        // effect can reach the current t without re-subscribing
        // (`tRef.current` in useChatEngine). All three are invisible to the
        // literal-call check: the character before the `t(` is a word
        // character, so `\bt\(` never matches. Same blind spot as the carrier
        // properties, 184 call sites wide — the fallback beside the key hides
        // a missing key forever.
        const RX = new RegExp(`(?:${ALIAS_CALL})\\s*(['"])(${KEY})\\2`, 'gm');
        const missing = [];
        for (const { rel, src } of sources) {
            for (const m of src.matchAll(RX)) {
                if (!known(m[3])) missing.push(`${rel}: ${(m[1] || 'tRef.current')}(${m[3]})`);
            }
        }
        expect(missing, `t() alias keys missing from en-defaults.js — add them to server/i18n/defaults/en/<namespace>.js and run node scripts/gen-i18n-defaults.mjs, or put them on PENDING_KEYS:\n${missing.join('\n')}`).toEqual([]);
    });

});

// Helper modules that compose their own sentences. They have no JSX, often no
// t() at all, and are the last place a key can hide. Third describe for the
// same reason as the second: the function-size cap.
describe('i18n guard — helpers that compose text', () => {
    it('every key handed to a text helper as an argument is a real key', () => {
        // `nOf(t, 'knowledge.n_sources', n, …)`, `nameOf(list, id, 'k', 'Fb')`,
        // `tx(t, 'visibility.n_groups', …)`: the key is an argument, so no
        // `t(`-shaped pattern reaches it. The `_plural` half is worse — the
        // dictionary never sees it as a literal anywhere, it is built at
        // runtime from the base key, and that is the mechanical anchor under
        // the singular/`_plural` convention stated at the top of this file.
        //
        // The call itself is located by COUNTING brackets (keyArgCalls), not by
        // matching them: see its comment for why no regex reaches the six
        // deepest call sites.
        const missing = sources.flatMap(({ rel, src }) => unknownArgKeys(rel, src));
        expect(missing, `keys passed to a text helper (and the _plural forms they derive) missing from en-defaults.js:\n${missing.join('\n')}`).toEqual([]);
    });

    it('every `key:` in a registered { key, en } table is a real key', () => {
        const missing = unknownTableKeys(KEY_TABLE_FILES, (rel) => sourceOf(rel)?.src);
        expect(missing, `{ key, en } tables naming keys missing from en-defaults.js — add them to server/i18n/defaults/en/<namespace>.js and run node scripts/gen-i18n-defaults.mjs, or put them on PENDING_KEYS:\n${missing.join('\n')}`).toEqual([]);
    });

    it('a registered text helper returns no English sentence without a key beside it', () => {
        // A returned value with no key in that window is a sentence the
        // Languages panel cannot reach — `TRIGGER_LABELS`, 'just now',
        // 'expires in {h}h'. Files still in that state carry `pending:`, and
        // the assertion runs both ways: a clean file may not claim debt.
        const wrong = [];
        for (const { rel, pending } of TEXT_HELPERS) {
            const bare = bareProse(rel);
            if (!pending && bare.length) wrong.push(`UNTRANSLATABLE — ${bare.join('\n  ')}`);
            if (pending && !bare.length) wrong.push(`CLEAN NOW — drop the pending: from TEXT_HELPERS for ${rel}`);
        }
        expect(wrong, `registered text helpers composing English with no key beside it:\n${wrong.join('\n')}`).toEqual([]);
    });

    it('the register does not undercount: every .js/.ts module of a helper shape is on it', () => {
        // The counterpart to the rot check. That one only ever REMOVES: it
        // fails on a registered file that is gone. Nothing pulled a new helper
        // in, so the register listed four pending files where nineteen modules
        // had the shape — eight of them the same relative-time ladder. A stage
        // reading the register would have cleaned four and left the rest, which
        // is the whole failure this file exists to prevent, one level up.
        //
        // Scope is `.js`/`.ts` only, and it is in the NAME of this test because
        // the claim is only as wide as the scan: the same scan over `.jsx`/
        // `.tsx` finds 34 more modules of these shapes (17 clocks, 17 label
        // tables — shell/NotificationCenter.jsx among them, with its own "{n}w
        // ago"). Those are real copy, but they render, so a screen stage reads
        // them off its own screen; a register of nearly sixty files is one
        // nobody plans against. The figure is written down in the internal
        // i18n conventions (§4.2, see the file header), so the count a
        // KRITIEK #30 stage plans against is not silently this test's 23.
        const registered = new Set(TEXT_HELPERS.map(h => h.rel));
        const missing = [];
        for (const { rel, src } of sources) {
            if (!/\.(js|ts)$/.test(rel) || registered.has(rel)) continue;
            if (HELPER_SCAN_SKIP.some(prefix => rel.startsWith(prefix))) continue;
            const code = stripComments(src);
            const shape = HELPER_SHAPES.find(s => s.has(code));
            if (!shape || !bareProse(rel).length) continue;
            missing.push(`${rel} — ${shape.what}`);
        }
        expect(missing, `.js/.ts helper modules composing English that TEXT_HELPERS does not list. Add each one with a pending: note saying which stage owns it (or fix it and add its keys):\n${missing.join('\n')}`).toEqual([]);
    });
});

// The two dictionaries as a pair, and the written-down debt that keeps this
// file green without hiding anything. Fourth describe: function-size cap.
describe('i18n guard — dictionary pairing and the debt ledgers', () => {
    it('the broken `alias(key) || fallback` idiom is not used either', () => {
        // Same bug as the `t(key) || fallback` ban above, one alias further
        // out: `_t('automations.overdue') || 'Overdue'` reads as a safe fallback,
        // but `_t` IS t() — it returns the truthy raw key when the key is
        // missing, so the `||` never fires and the screen prints the key.
        const RX = new RegExp(`(?:${ALIAS_CALL})\\s*(['"])[^'"]+?\\2\\s*\\)\\s*\\|\\|`, 'gm');
        const hits = [];
        for (const { rel, src } of sources) {
            for (const m of src.matchAll(RX)) {
                hits.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
            }
        }
        expect(hits, `an alias of t() returns the raw key when missing, so "|| fallback" never fires. Use alias('key', 'Fallback'):\n${hits.join('\n')}`).toEqual([]);
    });

    it('both dictionaries give the same key the same English', () => {
        // The parity check above compares KEY SETS, so it is blind to this: a
        // key present in both with different text. The user then reads one
        // sentence offline (the client fallback) and another one online (the
        // server dictionary). It is also the cheapest possible proof of the
        // serial rule — whoever appends to one file appended to the other.
        const require_ = createRequire(import.meta.url);
        const { GUI_DEFAULTS } = require_(SERVER_DEFAULTS);
        const drift = Object.keys(EN_DEFAULTS)
            .filter(k => k in GUI_DEFAULTS && EN_DEFAULTS[k] !== GUI_DEFAULTS[k]);
        const fresh = drift.filter(k => !PENDING_VALUE_DRIFT.has(k))
            .map(k => `${k}\n  client: ${JSON.stringify(EN_DEFAULTS[k])}\n  server: ${JSON.stringify(GUI_DEFAULTS[k])}`);
        const settled = [...PENDING_VALUE_DRIFT].filter(k => !drift.includes(k));
        expect(fresh, `keys whose English differs between the two dictionaries — pick one wording and write it in both:\n${fresh.join('\n')}`).toEqual([]);
        expect(settled, `these agree now — remove them from PENDING_VALUE_DRIFT:\n${settled.join('\n')}`).toEqual([]);
    });

    it('the ledgers and registers do not rot', () => {
        // Every exemption in this file is a claim about the tree, and a claim
        // that stops being true is worse than no claim: it silently exempts
        // whatever moved into its place. So each one is checked from the other
        // side — a landed key, a renamed file, a table that no longer holds a
        // key must all come off their list.
        const stale = [];
        for (const [key, where] of PENDING_KEYS) {
            if (key in EN_DEFAULTS) stale.push(`LANDED — remove ${key} from PENDING_KEYS (${where})`);
        }
        stale.push(
            ...listRot('KEY_TABLE_FILES', KEY_TABLE_FILES, new RegExp(`\\bkey:\\s*(['"])(${KEY})\\1`), 'KEYS'),
            ...listRot('TEXT_HELPERS', TEXT_HELPERS.map(h => h.rel)),
            // The zone is a claim about these three files: a carrier name here
            // means a column. A file that no longer has such a property is no
            // longer that zone, and leaving it listed would flip the rule for
            // whatever moves in next.
            ...listRot('FIELD_SELECTOR_FILES', FIELD_SELECTOR_FILES, new RegExp(`\\b(${CARRIERS.join('|')}):\\s*['"]`), 'FIELD SELECTORS'),
        );
        for (const prefix of HELPER_SCAN_SKIP) {
            if (!sources.some(s => s.rel.startsWith(prefix))) stale.push(`GONE — remove ${prefix} from HELPER_SCAN_SKIP`);
        }
        // EXCLUDED is checked against the DISK: collectSources() drops those
        // files, so sourceOf() can never find one.
        for (const rel of EXCLUDED) {
            if (!fs.existsSync(path.join(SRC, rel))) stale.push(`GONE — remove ${rel} from EXCLUDED`);
        }
        expect(stale, `exemptions that no longer describe the tree:\n${stale.join('\n')}`).toEqual([]);
    });
});

// The two scanners that FIND the keys carried as data, tested on fixtures
// instead of on the tree. Everything above asserts "the tree is clean", which a
// scanner that finds nothing satisfies just as well as a scanner that works —
// so a repair to the scanner itself is unguarded unless something proves the
// scanner still bites. Fifth describe for the usual reason (the function-size
// cap, eslint.config.js: max-lines-per-function 80).
describe('i18n guard — the scanners themselves bite', () => {
    // The pattern this replaced, kept only to be asserted BLIND. Without it
    // "the new scan finds the key" says nothing: a scan that always finds
    // everything would pass too.
    const oldArgRx = () => new RegExp(`\\b(${KEY_ARG_HELPERS.join('|')})\\(([^()]*)\\)`, 'g');

    it('the helper-argument scan crosses nested brackets the old regex could not', () => {
        const src = "const s = nOf(t, 'zz.fixture_nested', countOf(x), 'one {count}', 'many {count}');";
        expect([...src.matchAll(oldArgRx())], 'the old regex must be blind here, or the fixture proves nothing').toEqual([]);
        expect(keyArgCalls(src).map(c => c.fn)).toEqual(['nOf']);
        expect(keyArgCalls(src)[0].args).toContain('zz.fixture_nested');
        // The derived `_plural` half comes out too: both are unknown, so both
        // must be reported — that is the whole point of reaching the call.
        expect(unknownArgKeys('zz/fixture.js', src)).toEqual([
            "zz/fixture.js: nOf(… 'zz.fixture_nested')",
            "zz/fixture.js: nOf('zz.fixture_nested') derives zz.fixture_nested_plural",
        ]);

        // And the same anchored on the real tree, so the fixture cannot drift
        // away from what the tree actually contains: the `_isoMutate(` calls
        // moved from the compliance hub into its data layer in the Sep 2026
        // redesign (components/admin/compliance/data/registers.js) — seven
        // calls, every one nested behind `() => fetchJson(…)`, so the old
        // regex sees NONE of them. An empty source fails the second count.
        const real = sourceOf('components/admin/compliance/data/registers.js')?.src || '';
        expect([...real.matchAll(oldArgRx())].filter(m => m[1] === '_isoMutate')).toHaveLength(0);
        expect(keyArgCalls(real).filter(c => c.fn === '_isoMutate')).toHaveLength(7);
    });

    it('the { key, en } table scan reports a key only when its file is on KEY_TABLE_FILES', () => {
        const rel = 'zz/fixture-table.js';
        const srcOf = (r) => (r === rel ? "const T = [{ id: 'a', key: 'zz.fixture_table', en: 'A' }];" : undefined);
        // On the list: reported. Off the list: silent. So it is the LIST that
        // bites — the reason adding a file to it is a real change and not a
        // decoration.
        expect(unknownTableKeys([rel], srcOf)).toEqual([`${rel}: key: zz.fixture_table`]);
        expect(unknownTableKeys([], srcOf)).toEqual([]);
    });
});
