// The code step in the routines demo: a code step with described inputs in
// the spend report, and stand-ins for the three code endpoints. The demo has
// no server and never runs code: "analyze" reads the JSDoc with a small
// parser and flags a few obvious patterns, "Try it" answers a fixed result,
// and the assistant answers a scripted turn that visibly edits the code.

type Obj = Record<string, unknown>;

export const CODE_TO_EUROS = `/**
 * Converts each vendor total to euros and rounds it to cents.
 *
 * @param {object[]} totals - The totals per vendor, from the step before
 * @param {number} [rate=0.92] - Euros per US dollar
 * @param {'EUR'|'USD'} [currency='USD'] - The currency the totals are in
 * @returns {{ vendors: object[] }} Every vendor with its total in euros
 */
async function main(inputs, ctx) {
    const factor = inputs.currency === 'EUR' ? 1 : inputs.rate;
    const vendors = inputs.totals.map((v) => ({
        vendor: v.vendor,
        euros: Math.round(v.total * factor * 100) / 100,
    }));
    ctx.log('converted', vendors.length, 'vendors');
    return { vendors };
}`;

export const CODE_STEP = {
    id: 'to_euros',
    type: 'code',
    label: 'Convert totals to euros',
    language: 'javascript',
    code: CODE_TO_EUROS,
    inputs: {
        totals: { kind: 'ref', path: 'steps.total_per_vendor.groups' },
        rate: { kind: 'literal', value: 0.92 },
    },
};

const humanise = (name: string) => {
    const words = name.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().split(/\s+/);
    return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
};

function typeOf(raw: string): Obj {
    const t = raw.trim();
    if (/^'[^']*'(\s*\|\s*'[^']*')+$/.test(t)) return { type: 'string', enum: t.split('|').map((s) => s.trim().slice(1, -1)) };
    if (/\[\]$|^Array</.test(t)) return { type: 'array' };
    if (/^(number|integer|boolean|object)$/.test(t)) return { type: t };
    return { type: 'string' };
}

/** A small reading of the JSDoc on main, enough for the demo's form. */
export function demoAnalysis(code: string): Obj {
    const params: Obj[] = [];
    const lines = code.split('\n');
    let description: string | null = null;
    lines.forEach((line, i) => {
        const d = /^\s*\*\s+([A-Z][^@]*\.)\s*$/.exec(line);
        if (d && !description) description = d[1];
        const m = /@param\s+\{([^}]+)\}\s+(\[?)([\w.]+)(?:=([^\]]+))?\]?\s*(?:-\s*(.*))?$/.exec(line);
        if (!m) return;
        const name = m[3].replace(/^inputs\./, '');
        if (name === 'inputs' || name === 'ctx') return;
        let def: unknown;
        if (m[4] !== undefined) { try { def = JSON.parse(m[4].replace(/'/g, '"')); } catch { def = m[4]; } }
        params.push({ name, label: humanise(name), description: m[5] || null, ...typeOf(m[1]), required: !m[2], ...(def !== undefined ? { default: def } : {}), line: i + 1 });
    });
    const findings: Obj[] = [];
    const flag = (re: RegExp, ruleId: string, severity: string, message: string, fix: string) => {
        lines.forEach((line, i) => {
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- fixed demo patterns, one source line at a time
            if (re.test(line)) findings.push({ ruleId, severity, line: i + 1, column: 1, message, messageKey: `code_step.rule.${ruleId.replace(/-/g, '_')}`, fix, fixKey: `code_step.rule.${ruleId.replace(/-/g, '_')}_fix` });
        });
    };
    flag(/\beval\s*\(|new Function\s*\(/, 'dynamic-code', 'block', 'Code that writes and runs new code cannot be checked. Write the logic directly.', 'Write the logic directly instead of building it from text.');
    flag(/\brequire\s*\(|\bprocess\./, 'node-access', 'block', 'Code steps cannot load modules or reach the server. There are no files or processes here.', 'Write the logic in the step itself, or use an integration.');
    flag(/webhook\.site|requestbin|ngrok/, 'collection-host', 'warn', 'This address collects or forwards whatever is sent to it, so data sent there leaves your control.', 'Send the data to a service your organisation manages instead.');
    const hosts = [...new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))];
    const inputsRead = [...new Set([...code.matchAll(/inputs\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
    const declared = new Set(params.map((p) => p.name));
    return {
        ok: true, syntaxError: null, hash: `demo-${code.length}`, rulesetVersion: 'code-safety/1',
        description, params, returns: null, findings,
        capabilities: {
            hosts, dynamicHosts: false, tools: [], inputsRead, undeclaredInputs: inputsRead.filter((n) => !declared.has(n)),
            usesHttp: /ctx\.http\(/.test(code), usesDb: false, httpInLoop: false,
        },
        approvals: [],
    };
}

/** The assistant's scripted turn: adds a described "minimum" input and uses it. */
export function demoAssistCode(code: string): { code: string; reply: string; summary: string } {
    if (!code.trim()) {
        return { code: CODE_TO_EUROS, reply: 'Here is a first version. It converts every vendor total to euros; the rate and the currency are inputs with a short description, so the form below the step fills itself.', summary: 'Wrote the code' };
    }
    if (code.includes('inputs.minimum')) {
        return { code, reply: 'The code already leaves out vendors below the minimum. Anything else you want changed?', summary: '' };
    }
    const withParam = code.replace(/(\n\s*\*\s*@returns)/, "\n * @param {number} [minimum=0] - Leave out vendors below this amount in euros$1");
    const withFilter = withParam.replace(/\}\)\);/, '})).filter((v) => v.euros >= inputs.minimum);');
    return { code: withFilter, reply: 'Done: small vendors are left out now. I added a "Minimum" input with a default of 0, so the form shows it with a short explanation.', summary: 'Added a described "minimum" input and a filter' };
}

function sse(events: Array<[string, Obj]>): Response {
    const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export const CODE_ROUTES = {
    'POST /api/automation/code/analyze': ({ body }: { body: Obj | null }) => demoAnalysis(String(body?.code || '')),
    'POST /api/automation/code/test': ({ body }: { body: Obj | null }) => {
        const inputs = (body?.inputs || {}) as Obj;
        const rate = Number(inputs.rate ?? 0.92);
        const min = Number(inputs.minimum ?? 0);
        const vendors = [['OpenAI', 1840], ['Anthropic', 1210], ['Figma', 96]]
            .map(([vendor, total]) => ({ vendor, euros: Math.round(Number(total) * rate * 100) / 100 }))
            .filter((v) => v.euros >= min);
        return { result: { vendors }, logs: [`converted ${vendors.length} vendors`], calls: [], durationMs: 14 };
    },
    'POST /api/automation/builder/code/assist': ({ body }: { body: Obj | null }) => {
        const turn = demoAssistCode(String(body?.code || ''));
        const events: Array<[string, Obj]> = [['delta', { text: turn.reply }]];
        if (turn.summary) events.push(['edit', { op: 'patch', summary: turn.summary }]);
        events.push(['code', { code: turn.code, analysis: demoAnalysis(turn.code), changed: turn.code !== body?.code, repairRounds: 0 }]);
        events.push(['done', { usage: {} }]);
        return sse(events);
    },
};
