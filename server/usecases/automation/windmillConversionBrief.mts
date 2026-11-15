/**
 * windmillConversionBrief.mts: the briefing "Complete with AI" puts in the AI
 * automation builder for one imported draft (PLAN B4.1). Deterministic, no
 * LLM: built from the stored import report.
 *
 *   buildConversionBrief(report, { perItemChars, totalChars }) → string
 *
 * What it holds: the title and Windmill path, the count of what was carried
 * over and what is open, per open item its placeholder step id, what it was,
 * why it is open, the inputs it read and its source (already scrubbed by the
 * converter, cut to the caps), the connections to choose, the ids to pick
 * again, and the instruction to dry-run, fix, finalise and never switch it
 * on. The source is IN the message: builder attachments reach the model only
 * as a name.
 *
 * No token and no secret is ever in a report, so none is in a brief. The
 * builder sends the brief to the organisation's own model through its usual
 * gates; the person sees it in the input box and sends it themselves.
 */

export interface BriefLimits {
    /** Characters of source per item (0 = unlimited). */
    perItemChars: number;
    /** Characters of the whole brief (0 = unlimited). */
    totalChars: number;
}

type Item = { wmId?: unknown; stepId?: unknown; title?: unknown; why?: unknown; language?: unknown; source?: unknown; inputs?: unknown };
type Report = Record<string, any>;

const cut = (text: string, max: number): string => (max > 0 && text.length > max ? `${text.slice(0, max)}\n… (cut; the note step on the canvas has the rest)` : text);

function inputsText(inputs: unknown): string {
    if (!inputs || typeof inputs !== 'object' || !Object.keys(inputs).length) return '';
    const json = JSON.stringify(inputs);
    return json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
}

function itemBlock(item: Item, n: number, limits: BriefLimits): string {
    const lines = [`${n}. ${String(item.title ?? item.wmId ?? 'Open item')}`];
    if (typeof item.stepId === 'string' && item.stepId) lines.push(`   Placeholder step: ${item.stepId} (a "Windmill: …" stop step on the canvas)`);
    else lines.push('   No placeholder step: this applies to the automation as a whole.');
    if (item.why) lines.push(`   Why it is open: ${String(item.why)}`);
    if (item.language) lines.push(`   Language: ${String(item.language)}`);
    const inputs = inputsText(item.inputs);
    if (inputs) lines.push(`   What it read (Windmill expressions, as found): ${inputs}`);
    if (typeof item.source === 'string' && item.source.trim()) {
        lines.push('   Source (read-only, for reference; never run it):');
        lines.push('   ```');
        lines.push(cut(item.source, limits.perItemChars));
        lines.push('   ```');
    }
    return lines.join('\n');
}

function headLines(report: Report, openCount: number): string[] {
    const title = String(report.title ?? report.flowPath ?? 'this automation');
    const counts = (report.counts ?? {}) as Record<string, number>;
    const carried = (counts.mapped ?? 0) + (counts.pattern ?? 0) + (counts.shim ?? 0);
    return [
        `Complete this automation that was imported from Windmill: "${title}" (Windmill path ${String(report.flowPath ?? '?')}).`,
        `The importer carried over the trigger and ${carried} step(s); ${openCount} item(s) are still open.`,
        '',
    ];
}

function tailLines(report: Report): string[] {
    const tail: string[] = [];
    const connections = Array.isArray(report.connections) ? report.connections : [];
    if (connections.length) {
        tail.push('Connections to choose (no secret was carried over):');
        for (const c of connections) tail.push(`- ${String(c.kind)} ${String(c.path)}${c.resourceType ? ` (${String(c.resourceType)})` : ''}`);
        tail.push('');
    }
    const repick = (Array.isArray(report.warnings) ? report.warnings : []).filter((w: { code?: string }) => w?.code === 'repick_id');
    if (repick.length) {
        tail.push('Ids to pick again (they differ between installations):');
        for (const w of repick) tail.push(`- ${String(w.message)}`);
        tail.push('');
    }
    tail.push(
        'What to do:',
        '- Replace every placeholder step with native steps. Keep the steps that were already converted.',
        '- Use the Nextcloud tools where the source called Nextcloud. Turn Python, Bash or SQL into what it means; never run it. Use a code step only for pure data shaping.',
        '- Run a dry run, fix every finding, then finalize.',
        '- Do not switch the automation on: a person does that after reviewing the import report.',
    );
    return tail;
}

export function buildConversionBrief(report: Report, limits: BriefLimits): string {
    const items: Item[] = Array.isArray(report.aiChecklist) ? report.aiChecklist : [];
    const head = headLines(report, items.length);
    const tailText = tailLines(report).join('\n');
    const budget = limits.totalChars > 0 ? limits.totalChars - head.join('\n').length - tailText.length - 2 : 0;
    const blocks: string[] = [];
    let used = 0;
    for (let i = 0; i < items.length; i++) {
        const block = itemBlock(items[i], i + 1, limits);
        if (limits.totalChars > 0 && used + block.length > budget) {
            blocks.push(`… ${items.length - i} more item(s) are listed in the import report and as note steps on the canvas.`);
            break;
        }
        blocks.push(block);
        used += block.length + 1;
    }
    return [...head, 'Open items:', ...blocks, '', tailText].join('\n');
}
