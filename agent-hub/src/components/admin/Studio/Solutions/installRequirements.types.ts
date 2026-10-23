/**
 * What is in a Blueprint, and what the person installing it will have to
 * supply — read off the file itself, before anything is created.
 *
 * ── Why this is read on the client at all ─────────────────────────────────
 *
 * The server answers the same question, but only in the install REPORT, which
 * arrives after the Solution exists. A wizard that asks "which table should
 * this step use?" has to ask BEFORE the install, so the only copy of the file
 * available at that moment is the one in the browser.
 *
 * Two consequences worth knowing:
 *
 *   1. This is the SHOWING half; projects/packaging/install.js is the DECIDING
 *      half. Nothing here is a permission check and nothing here is trusted by
 *      the server — a body this module produced still goes through
 *      projects/packaging/resolutions.js, which drops anything it does not
 *      recognise. If the two ever disagree about what a file asks for, the
 *      server wins, and the post-install report it returns lists the grants it
 *      refused whether or not this module spotted them.
 *   2. It reads the RAW file. `sanitizeManifest` strips every `ai.public*` key
 *      and every `fixedArgs` server-side, so by the time the server sees a
 *      manifest those requests are gone — and showing what was asked for is
 *      the entire reason the Connect step exists. `fixedArgs` VALUES are never
 *      carried out of here for the same reason the server does not echo them:
 *      they can hold a path, an id or a token.
 *
 * ── What counts as "the installer has to supply this" ─────────────────────
 *
 * Each of the three is a hole scrub.js left, recognisable by its exact shape:
 *
 *   table       a `datatable` step with an EMPTY `datatableId` — scrub blanks
 *               the id and leaves the author's own `datatableKey` standing.
 *               Only for keys this Blueprint does not bring a table for: a
 *               Solution that ships its own "invoices" table needs nothing.
 *   connection  an `http_request` step whose `auth` is exactly `null`. That is
 *               what scrub writes when it removes a credential; a step that
 *               never had one has no `auth` key at all, so the two are
 *               distinguishable and only the first is asked about.
 *   approver    an `approval` step with none of the four seat fields set.
 *               Advisory rather than blocking — an unseated approval means the
 *               automation's owner decides — so the row says so rather than
 *               demanding a pick.
 *
 * No English sentences leave this module: every row is data, and the modal
 * renders it through `t()`. A helper that returned prose would put copy in a
 * place no translator can reach.
 */

/** A step of a bundled automation, addressed the way the wizard keys its answers. */
export interface StepAddress {
    /** Read off a hand-made file, so nothing says it is a string. */
    ref: unknown;
    title: string;
    stepId: string;
    layerKey: string | null;
}

/** A table the installer has to pick, and the steps that ask for it. */
export interface TableRequirement {
    key: string;
    steps: StepAddress[];
}

export interface BlueprintRequires {
    tables: TableRequirement[];
    connections: StepAddress[];
    approvers: StepAddress[];
}

/** What a file claims about where it came from. */
export interface SourceClaim {
    blueprintId: string | null;
    orgId: string | null;
    orgName: string | null;
    version: number | null;
}

/** One thing a page of the file asks to be allowed to do. */
export interface GrantRow {
    ref: string | null;
    name: string;
    kind: string;
    tool?: string;
    flags?: Record<string, unknown>;
}

/** A manifest that is a Blueprint, read into what the wizard shows. */
export interface BlueprintReadOk {
    ok: true;
    name: string;
    description: string;
    version: number;
    counts: Record<string, number>;
    notCarried: string[];
    source: SourceClaim;
    requires: BlueprintRequires;
    grants: GrantRow[];
}

/** Anything that is not a Blueprint: the same fields, all absent. */
export interface BlueprintReadNone {
    ok: false;
    name?: undefined;
    description?: undefined;
    version?: undefined;
    counts?: undefined;
    notCarried?: undefined;
    source?: undefined;
    requires?: undefined;
    grants?: undefined;
}

export type BlueprintRead = BlueprintReadOk | BlueprintReadNone;

/** The answers the wizard collects, keyed by the row they answer. */
export interface InstallAnswers {
    tables?: Record<string, string>;
    connections?: Record<string, string>;
    approvers?: Record<string, string>;
}

/** An object-shaped value read out of a file: nothing in it is trusted yet. */
export type Obj = Record<string, unknown>;

/**
 * Every step of every graph in a definition, with its flowlet key.
 *
 * The browser twin of automation/portability.walkAllSteps. Deliberately not
 * shared: the server's walker also visits triggers and owns the nesting rules,
 * and all a wizard needs is "which steps, in which graph". Anything it misses
 * shows up in the post-install report rather than silently changing what
 * installs.
 */
export type StepVisitor = (step: Obj, layerKey: string | null) => void;
