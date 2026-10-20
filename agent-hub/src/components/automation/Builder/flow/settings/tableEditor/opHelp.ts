import type { OpKind } from './tableOpModel';

export type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** What an operation is called and what it is for, in one plain sentence. */
export interface OpTitle { title: string; blurb: string }

function titles(t: Translate) {
    const ops: Record<OpKind, OpTitle> = {
        join: { title: t('automation_tables.op.join.title', 'Add columns from another table'), blurb: t('automation_tables.op.join.blurb', 'Match each row with a row of a second table and bring its columns along.') },
        filter: { title: t('automation_tables.op.filter.title', 'Keep rows that match'), blurb: t('automation_tables.op.filter.blurb', 'Keep only the rows that meet your rules. The others are left out.') },
        select: { title: t('automation_tables.op.select.title', 'Choose columns'), blurb: t('automation_tables.op.select.blurb', 'Keep or drop columns, and rename them.') },
        sample: { title: t('automation_tables.op.sample.title', 'Take a sample'), blurb: t('automation_tables.op.sample.blurb', 'Keep the first rows, or a random selection that comes out the same every time.') },
        derive: { title: t('automation_tables.op.derive.title', 'Add calculated columns'), blurb: t('automation_tables.op.derive.blurb', 'Make a new column from other columns, with text, numbers or a formula.') },
        bucket: { title: t('automation_tables.op.bucket.title', 'Sort into bands'), blurb: t('automation_tables.op.bucket.blurb', 'Turn numbers or values into bands, such as age groups or quarters.') },
        group: { title: t('automation_tables.op.group.title', 'Group and count'), blurb: t('automation_tables.op.group.blurb', 'Group rows by one or more columns and count, add up or average within each group.') },
        pivot: { title: t('automation_tables.op.pivot.title', 'Cross-tabulate'), blurb: t('automation_tables.op.pivot.blurb', 'Put one column down the side and another across the top, with counts or totals in the cells.') },
        groups: { title: t('automation_tables.op.groups.title', 'Split into segments'), blurb: t('automation_tables.op.groups.blurb', 'Make a list of groups to compare, each one large enough to be shown.') },
        pseudonymise: { title: t('automation_tables.op.pseudonymise.title', 'Replace names by a code'), blurb: t('automation_tables.op.pseudonymise.blurb', 'Swap names, e-mail addresses or ids for a code. The same person always gets the same code, so rows can still be matched.') },
        describe: { title: t('automation_tables.op.describe.title', 'Describe the columns'), blurb: t('automation_tables.op.describe.blurb', 'Find out what each column holds: the options, the range and whether it looks personal.') },
    };
    const menuGroups: Record<string, string> = {
        combine: t('automation_tables.group.combine', 'Combine'),
        clean: t('automation_tables.group.clean', 'Clean up'),
        calculate: t('automation_tables.group.calculate', 'Calculate'),
        summarise: t('automation_tables.group.summarise', 'Summarise'),
        protect: t('automation_tables.group.protect', 'Protect'),
        inspect: t('automation_tables.group.inspect', 'Inspect'),
    };
    return { ops, menuGroups };
}

function labels(t: Translate) {
    const tests: Record<string, string> = {
        equals: t('automation_tables.test.equals', 'is'),
        not_equals: t('automation_tables.test.not_equals', 'is not'),
        contains: t('automation_tables.test.contains', 'contains'),
        not_contains: t('automation_tables.test.not_contains', 'does not contain'),
        starts_with: t('automation_tables.test.starts_with', 'starts with'),
        ends_with: t('automation_tables.test.ends_with', 'ends with'),
        in: t('automation_tables.test.in', 'is one of'),
        not_in: t('automation_tables.test.not_in', 'is none of'),
        gt: t('automation_tables.test.gt', 'is more than'),
        gte: t('automation_tables.test.gte', 'is at least'),
        lt: t('automation_tables.test.lt', 'is less than'),
        lte: t('automation_tables.test.lte', 'is at most'),
        between: t('automation_tables.test.between', 'is between'),
        is_empty: t('automation_tables.test.is_empty', 'is empty'),
        is_not_empty: t('automation_tables.test.is_not_empty', 'is not empty'),
        contains_item: t('automation_tables.test.contains_item', 'lists the item'),
    };
    const aggs: Record<string, string> = {
        count: t('automation_tables.agg.count', 'Count rows'),
        sum: t('automation_tables.agg.sum', 'Total'),
        mean: t('automation_tables.agg.mean', 'Average'),
        median: t('automation_tables.agg.median', 'Median'),
        min: t('automation_tables.agg.min', 'Lowest'),
        max: t('automation_tables.agg.max', 'Highest'),
        count_distinct: t('automation_tables.agg.count_distinct', 'Count different values'),
        share: t('automation_tables.agg.share', 'Share of all rows (%)'),
    };
    return { tests, aggs };
}

function joinToBucket(t: Translate) {
    return {
        join: {
            with: t('automation_tables.help.join.with', 'The second table. Pick the output of a step that made a table.'),
            how: t('automation_tables.help.join.how', 'Keep all rows adds the columns where a match exists and leaves them empty otherwise. Only matching rows drops the rows with no match.'),
            on: t('automation_tables.help.join.on', 'Which column in each table says two rows belong together, such as an id or an e-mail address.'),
            alternatives: t('automation_tables.help.join.alternatives', 'Other names the column may have in the second table. The first one that exists is used.'),
            caseInsensitive: t('automation_tables.help.join.case', 'Treat capital and small letters as the same.'),
            trim: t('automation_tables.help.join.trim', 'Ignore spaces before and after the value.'),
            columns: t('automation_tables.help.join.columns', 'Which columns of the second table to bring along. Leave on all to take every column except the matching ones.'),
            prefix: t('automation_tables.help.join.prefix', 'Text put in front of the new column names, so they do not clash with the ones you have.'),
            onDuplicate: t('automation_tables.help.join.duplicate', 'If the second table has several matching rows: use the first one, or make a row for each.'),
        },
        pseudonymise: {
            columns: t('automation_tables.help.pseudonymise.columns', 'The columns that identify a person, such as name or e-mail. Their values are combined into one code.'),
            saltVar: t('automation_tables.help.pseudonymise.salt', 'The name of a Solution variable that holds a secret phrase of at least 16 characters. Without that phrase nobody can work out who a code belongs to. Set it once for the whole Solution, not in this step.'),
            output: t('automation_tables.help.pseudonymise.output', 'The name of the new column that holds the code.'),
            length: t('automation_tables.help.pseudonymise.length', 'How long the code is, from 8 to 64 characters. Longer codes are less likely to clash.'),
            keepColumns: t('automation_tables.help.pseudonymise.keep', 'Keep the original columns as well. Leave this off to protect people.'),
            dropColumns: t('automation_tables.help.pseudonymise.drop', 'More columns to remove, such as a phone number. They are removed even if you keep the originals above.'),
        },
        derive: {
            name: t('automation_tables.help.derive.name', 'The name of the new column. A column with this name is replaced.'),
            value: t('automation_tables.help.derive.value', 'Build the value from the columns of the row (shown as row) and from variables. Pick a column, add text, or use a formula.'),
        },
        bucket: {
            column: t('automation_tables.help.bucket.column', 'The column whose values are sorted into bands.'),
            output: t('automation_tables.help.bucket.output', 'The name of the new column. Leave empty to use the column name followed by (group).'),
            mode: t('automation_tables.help.bucket.mode', 'Bands: you set the limits. Equal parts: the rows are divided into groups of the same size. Value list: you say which values belong together.'),
            bands: t('automation_tables.help.bucket.bands', 'A band starts at its lowest value and stops just before its highest. Leave one end empty for open-ended.'),
            quantiles: t('automation_tables.help.bucket.quantiles', 'How many groups of the same size, from 2 to 20. 4 gives quarters.'),
            labels: t('automation_tables.help.bucket.labels', 'Names for the groups, separated by commas. Leave empty for Q1, Q2, and so on.'),
            map: t('automation_tables.help.bucket.map', 'Values that belong together get one label. Separate the values with commas.'),
            otherLabel: t('automation_tables.help.bucket.other', 'The label for everything that is in no band. Leave empty to leave those cells empty.'),
        },
    };
}

function groupToDescribe(t: Translate) {
    return {
        group: {
            by: t('automation_tables.help.group.by', 'The columns to group by. Leave empty to get one row for the whole table.'),
            aggregates: t('automation_tables.help.group.aggregates', 'What to work out in each group. Every line becomes a column.'),
            weight: t('automation_tables.help.group.weight', 'A column with a weight per row, for example when every row stands for several people. Leave empty to count every row once.'),
            minN: t('automation_tables.help.group.min', 'Hide the numbers of groups with fewer rows than this, to protect the people in small groups. 0 shows every group.'),
            sort: t('automation_tables.help.group.sort', 'Order the result by one of its columns.'),
        },
        pivot: {
            rows: t('automation_tables.help.pivot.rows', 'The column whose values become the rows.'),
            columns: t('automation_tables.help.pivot.columns', 'The column whose values become the columns across the top.'),
            value: t('automation_tables.help.pivot.value', 'What goes in each cell: how many rows, or the total or average of a column.'),
            weight: t('automation_tables.help.pivot.weight', 'A column with a weight per row. Leave empty to count every row once.'),
            percent: t('automation_tables.help.pivot.percent', 'Show the cells as a percentage of their row, their column or the whole table.'),
            totals: t('automation_tables.help.pivot.totals', 'Add a total row and a total column.'),
            minN: t('automation_tables.help.pivot.min', 'Hide cells that are based on fewer rows than this. 0 shows every cell.'),
            decimals: t('automation_tables.help.pivot.decimals', 'How many decimals the cells show, from 0 to 6.'),
            missingLabel: t('automation_tables.help.pivot.missing', 'The name given to rows that have no value in the column.'),
        },
        filter: {
            match: t('automation_tables.help.filter.match', 'A row stays when all the rules are true, or when any one of them is.'),
            rules: t('automation_tables.help.filter.rules', 'Each rule looks at one column. Text is compared without regard to capitals or spaces around it.'),
            value: t('automation_tables.help.filter.value', 'The value to compare with. Type it, or pick data from an earlier step.'),
            list: t('automation_tables.help.filter.list', 'One value per line.'),
            separator: t('automation_tables.help.filter.separator', 'The character that separates the items in the cell. A semicolon is usual.'),
            rulesFrom: t('automation_tables.help.filter.rules_from', 'Rules that an earlier step made while the automation runs, such as from an AI step. They are applied when the automation runs, not in this preview.'),
            expr: t('automation_tables.help.filter.expr', 'For rules the list cannot express. A row stays when the formula is true. Refer to a column as row.name.'),
        },
        select: {
            keep: t('automation_tables.help.select.keep', 'Only these columns stay, in this order.'),
            drop: t('automation_tables.help.select.drop', 'These columns are removed. All others stay.'),
            rename: t('automation_tables.help.select.rename', 'Give a column another name.'),
        },
        sample: {
            mode: t('automation_tables.help.sample.mode', 'The first rows of the table, or a random selection. A random selection is the same every time the automation runs with the same data.'),
            size: t('automation_tables.help.sample.size', 'Take a number of rows or a percentage of them, not both.'),
            seed: t('automation_tables.help.sample.seed', 'Any text. Change it to get another random selection.'),
        },
        groups: {
            splits: t('automation_tables.help.groups.splits', 'Each column splits the rows into groups, one for each value. You can limit it to some values, or split cells that hold several values.'),
            values: t('automation_tables.help.groups.values', 'Only these values make a group. Leave empty for all of them. Separate with commas.'),
            separator: t('automation_tables.help.groups.separator', 'If a cell holds several values, the character between them, such as a semicolon.'),
            includeTotal: t('automation_tables.help.groups.total', 'Add a segment with all the rows, to compare the others with.'),
            minN: t('automation_tables.help.groups.min', 'Groups with fewer rows than this are hidden to protect the people in them. Your organisation can set a higher minimum, and that one then applies.'),
        },
        describe: {
            columns: t('automation_tables.help.describe.columns', 'Which columns to describe. Leave on all columns to describe every one.'),
            maxOptions: t('automation_tables.help.describe.max', 'A column with more different values than this is not listed value by value.'),
        },
    };
}

/**
 * Every sentence of the "Edit table" editor that explains rather than labels:
 * what an operation does and what each of its settings means. One place, so
 * the wording stays plain and the same everywhere it is shown.
 */
export function opHelp(t: Translate) {
    return {
        ...titles(t),
        ...labels(t),
        ...joinToBucket(t),
        ...groupToDescribe(t),
        note: t('automation_tables.help.note', 'A note for yourself or for colleagues. It does not change the result.'),
    };
}

export type OpHelp = ReturnType<typeof opHelp>;
