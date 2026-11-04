/**
 * Which `vars.<name>` an automation can read: the names something gives a
 * value before or during a run. Pure; used by the validator
 * (stepRules/referenceScoping.js: `ref.unknown_var`, `ai_check.list_unset`)
 * and by the builder when a tool call binds a path (builderTools/refCheck.js).
 *
 * The WRITERS of `runState.vars`, checked against the runner (grep `vars` in
 * core/automationRunner and core/automationModel):
 *   1. `definition.vars` of the root document: runSetup.js seeds the run with
 *      it (stageVars.runVarsFor), before the first step runs.
 *   2. The Solution variable values of the automation's project, laid over 1
 *      (stageVars.runVarsFor via solutionStageStore.variableValuesFor). They
 *      are not in the definition: the validator only knows them when its
 *      caller passes `knownVarNames` (liveSideEffects.knownVarNamesFor), and
 *      the callers add them to the set this module returns.
 *   3. `layers.<key>.vars`: a partial run of a flowlet reads them when the
 *      root has no `vars` (partialRuns.js `def.vars || layer.vars`). A full
 *      run hands every flowlet the root's object by reference
 *      (execFlow.execCallLayer `vars: runState.vars`), so a flowlet's own vars
 *      are only seen in that partial run; they count as written all the same,
 *      so a name the document declares anywhere never blocks anything.
 * Nothing else writes them. A step writes its own output (`steps.<id>.output`;
 * an Edit data / `set` step included), a loop binds `loop.<var>`, a flowlet's
 * inputs become its `trigger.output`, and a code step receives copies of its
 * inputs. Every writer therefore exists before the first step runs, so the
 * order of the graph plays no part: a name is written for every step or for
 * none.
 */

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);

const ownNames = (v: unknown): string[] => (isPlain(v) ? Object.keys(v) : []);

/** Every `vars.<name>` the definition gives a value (writers 1 and 3 above). */
export function varsWrittenBy(definition: unknown): Set<string> {
    const out = new Set<string>();
    if (!isPlain(definition)) return out;
    for (const name of ownNames(definition.vars)) out.add(name);
    const layers = isPlain(definition.layers) ? definition.layers : {};
    for (const layer of Object.values(layers)) {
        if (isPlain(layer)) for (const name of ownNames(layer.vars)) out.add(name);
    }
    return out;
}

type ExprNode = { kind?: string, v?: unknown, segments?: ExprNode[], expr?: ExprNode, args?: ExprNode[] } & Record<string, unknown>;

/**
 * Every `vars.<name>` an expression reads, as written (`vars.x`, `vars["x"]`).
 * Walks the AST the way refPaths.exprStepIds does, so quoted text and a member
 * called `vars` are never mistaken for a read.
 */
export function varsReadByExpr(ast: unknown, out: string[] = []): string[] {
    if (!ast || typeof ast !== 'object') return out;
    const node = ast as ExprNode;
    if (node.kind === 'path' && Array.isArray(node.segments)) {
        const [first, second] = node.segments;
        if (first?.kind === 'name' && first.v === 'vars' && second) {
            if (second.kind === 'name') out.push(String(second.v));
            else if (second.kind === 'index' && second.expr?.kind === 'str') out.push(String(second.expr.v));
        }
        for (const s of node.segments) if (s.expr) varsReadByExpr(s.expr, out);
    }
    for (const key of ['a', 'b', 'cond', 'expr']) if (node[key]) varsReadByExpr(node[key], out);
    if (Array.isArray(node.args)) for (const a of node.args) varsReadByExpr(a, out);
    return out;
}

/** The two ways out, said the same way by the validator and the builder. */
export function unsetVarFix(name: string, { list = false }: { list?: boolean } = {}): string {
    if (list) {
        return `No step can set vars.${name}. Add an Edit data (set) step before this one with a field that holds the list as a literal (for example ["Low","Medium","High"]) and point the ref at steps.<that step id>.output.<field>, or point it at a list an earlier step already returns.`;
    }
    return `No step can set vars.${name}. Bind the value directly (kind:"literal"), or add an Edit data (set) step before this one that holds it and bind steps.<that step id>.output.<field>.`;
}

type PathToken = { type?: string, key?: unknown };
export type UnsetVarProblem = { kind: 'unset-var', sure: true, name: string, list: boolean };

/**
 * For the builder: the problem with a `vars.<name>` path whose name the
 * definition never sets, or null. `definition` is the ROOT document (the
 * draft); no definition means nothing is known and nothing is said.
 */
export function unsetVarProblem(definition: unknown, tokens: PathToken[], list = false): UnsetVarProblem | null {
    if (!isPlain(definition) || !Array.isArray(tokens) || tokens[0]?.key !== 'vars') return null;
    const second = tokens[1];
    if (!second || second.type !== 'prop' || second.key === undefined || second.key === null) return null;
    const name = String(second.key);
    return varsWrittenBy(definition).has(name) ? null : { kind: 'unset-var', sure: true, name, list };
}

/** The builder's sentence for an UnsetVarProblem. */
export function describeUnsetVar(problem: UnsetVarProblem, path: string): string {
    const what = problem.list ? 'so this list would always be empty and every answer would fail its check' : 'so it resolves to nothing at every run';
    return `"${path}" reads vars.${problem.name}, which nothing in this automation sets (variables come only from the automation's own variables), ${what}. ${unsetVarFix(problem.name, { list: problem.list })}`;
}
