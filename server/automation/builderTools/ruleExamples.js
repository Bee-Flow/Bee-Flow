/**
 * The rule shapes the AI may write in a Condition (condition, filter, switch
 * cases): only shapes the editor reads back as clickable rows.
 *
 * A model that writes `contains(lower(item.subject), "invoice")` or
 * `endsWith(item.attachments[*].filename, ".pdf")` builds a rule that works
 * (or seems to) but opens as a formula the author cannot click through, and
 * the second one checks only the last attachment. The tool schemas, the
 * builder prompt and the Suggest-outputs prompt all teach from this one list,
 * and a web test parses every example with the editor's own row parser.
 */

const CONDITION_RULE_EXAMPLES = Object.freeze([
    'contains(item.subject, "invoice")',
    'startsWith(item.from, "billing")',
    'endsWith(item.filename, ".pdf")',
    'equals(item.status, "open")',
    'item.amount > 1000',
    'isEmpty(item.notes)',
    '!isEmpty(item.attachments)',
    'anyOf(item.attachments[*].filename, "endsWith", ".pdf")',
    'everyOf(item.lines[*].qty, ">", 0)',
    'noneOf(item.labels[*].name, "equals", "spam")',
    'equals(fileType(item), "pdf")',
    'anyOf(fileType(item.attachments[*]), "equals", "pdf")',
    'contains(item.from, "fabrikam") && anyOf(fileType(item.attachments[*]), "equals", "pdf")',
]);

const CONDITION_RULES_HINT = 'Write rules in these shapes only — the editor shows them as clickable rows: '
    + `${CONDITION_RULE_EXAMPLES.join(' · ')}. `
    + 'The current item is `item`. Text helpers (contains, startsWith, endsWith, equals) already ignore upper/lower case: '
    + 'never wrap a field in lower() or upper(). '
    + 'A list inside each item is checked with anyOf / everyOf / noneOf(list[*].field, "<test>", value); '
    + 'tests: equals, !equals, contains, !contains, startsWith, endsWith, ==, !=, >, >=, <, <=, isEmpty, !isEmpty. '
    + 'fileType(...) gives pdf, word, excel, powerpoint, image, text, archive, audio, video or other. '
    + 'Join rows with && or with ||, not both. '
    + 'A step after a Condition reads what it keeps: steps.<id>.output.items, '
    + 'or steps.<id>.output.matchesByCase.<output> after a Condition with several outputs.';

/** The `builder_add_switch` example: a Condition with several outputs, working through attachments. */
const SWITCH_RULES_EXAMPLE = Object.freeze({
    arrayRef: 'steps.<readMany>.output.messages[*].attachments',
    cases: [
        { name: 'pdf', expr: 'equals(fileType(item), "pdf")' },
        { name: 'word', expr: 'equals(fileType(item), "word")' },
    ],
});

module.exports = { CONDITION_RULE_EXAMPLES, CONDITION_RULES_HINT, SWITCH_RULES_EXAMPLE };
