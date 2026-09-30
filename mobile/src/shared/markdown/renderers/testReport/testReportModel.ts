/**
 * A ```json-test-report, read into a typed report. The shape is the one the
 * web's TestReportRenderer documents for QA agents: a title, the tested URL,
 * a timestamp and duration, an optional summary, the tests (name, status,
 * category, severity, steps, error, screenshot) and recommendations and notes.
 *
 * The derived numbers are the web's: a missing summary is counted from the
 * tests, and the pass rate is passed over the four counts, rounded.
 */

export type TestStatus = 'passed' | 'failed' | 'warning' | 'skipped';
export type TestCategory = 'functionality' | 'ui' | 'performance' | 'accessibility' | 'security';
export type TestSeverity = 'critical' | 'major' | 'minor' | 'cosmetic';

export interface TestCase {
    name: string;
    /** Anything the web does not know is drawn as skipped there, and here. */
    status: TestStatus;
    duration: string;
    category: TestCategory | null;
    severity: TestSeverity | null;
    description: string;
    steps: string[];
    error: string;
    screenshot: string;
}

export interface TestSummary {
    passed: number;
    failed: number;
    skipped: number;
    warnings: number;
}

export interface TestReport {
    title: string;
    url: string;
    timestamp: string;
    duration: string;
    summary: TestSummary;
    tests: TestCase[];
    notes: string;
    recommendations: string[];
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | null =>
    options.find((o) => o === value) ?? null;

const STATUSES: readonly TestStatus[] = ['passed', 'failed', 'warning', 'skipped'];
const CATEGORIES: readonly TestCategory[] = ['functionality', 'ui', 'performance', 'accessibility', 'security'];
const SEVERITIES: readonly TestSeverity[] = ['critical', 'major', 'minor', 'cosmetic'];

/** A step or recommendation as the web prints it: text, or an object's description/action, or its JSON. */
export function itemText(item: unknown): string {
    if (typeof item === 'string') return item;
    if (isRecord(item)) return text(item.description) || text(item.action) || JSON.stringify(item);
    return JSON.stringify(item) ?? '';
}

function readCase(raw: unknown): TestCase | null {
    if (!isRecord(raw)) return null;
    return {
        name: text(raw.name),
        status: oneOf(raw.status, STATUSES) ?? 'skipped',
        duration: text(raw.duration),
        category: oneOf(raw.category, CATEGORIES),
        severity: oneOf(raw.severity, SEVERITIES),
        description: text(raw.description),
        steps: Array.isArray(raw.steps) ? raw.steps.map(itemText) : [],
        error: text(raw.error),
        screenshot: text(raw.screenshot),
    };
}

/** The web's summary: the report's own, or counted from the tests (`warning` counts as warnings). */
export function summarise(given: unknown, tests: readonly TestCase[]): TestSummary {
    if (isRecord(given)) {
        return { passed: count(given.passed), failed: count(given.failed), skipped: count(given.skipped), warnings: count(given.warnings) };
    }
    const n = (status: TestStatus) => tests.filter((t) => t.status === status).length;
    return { passed: n('passed'), failed: n('failed'), skipped: n('skipped'), warnings: n('warning') };
}

export function passRate(summary: TestSummary): number {
    const total = summary.passed + summary.failed + summary.skipped + summary.warnings;
    return total > 0 ? Math.round((summary.passed / total) * 100) : 0;
}

/** The web's banding of the pass rate: ≥ 80 green, ≥ 50 amber, else red. */
export function rateTone(rate: number): 'passed' | 'warning' | 'failed' {
    return rate >= 80 ? 'passed' : rate >= 50 ? 'warning' : 'failed';
}

export function readTestReport(source: string): TestReport | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;
    const tests = (Array.isArray(parsed.tests) ? parsed.tests : []).map(readCase).filter((t): t is TestCase => t !== null);
    return {
        title: text(parsed.title),
        url: text(parsed.url),
        timestamp: text(parsed.timestamp),
        duration: text(parsed.duration),
        summary: summarise(parsed.summary, tests),
        tests,
        notes: text(parsed.notes),
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(itemText) : [],
    };
}
