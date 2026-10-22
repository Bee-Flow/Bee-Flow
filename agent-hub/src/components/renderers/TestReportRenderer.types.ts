/**
 * TestReportRenderer — Renders structured test reports for QA/testing agents
 * Triggered by ```json-test-report code blocks in MarkdownRenderer
 * 
 * Expected JSON shape:
 * {
 *   title: "Test Report Title",
 *   url: "https://tested-site.com",
 *   timestamp: "2024-01-15T10:30:00Z",
 *   duration: "2m 34s",
 *   summary: { passed: 5, failed: 2, skipped: 1, warnings: 3 },
 *   tests: [
 *     {
 *       name: "Login form validation",
 *       status: "passed" | "failed" | "skipped" | "warning",
 *       duration: "1.2s",
 *       category: "functionality" | "ui" | "performance" | "accessibility" | "security",
 *       description: "Tested login form with valid/invalid inputs",
 *       steps: ["Navigated to /login", "Entered valid email", ...],
 *       error: "Expected submit button to be enabled",
 *       screenshot: "data:image/png;base64,...",
 *       severity: "critical" | "major" | "minor" | "cosmetic"
 *     }
 *   ],
 *   notes: "Overall the site works well but...",
 *   recommendations: ["Fix the broken login flow", "Add ARIA labels"]
 * }
 */
export interface TestStep {
    description?: string;
    action?: string;
}

export interface TestCase {
    name?: string;
    status: string;
    duration?: string;
    category: string;
    description?: string;
    steps?: (string | TestStep)[];
    error?: string;
    screenshot?: string;
    severity?: string;
}

export interface TestReportData {
    title?: string;
    url?: string;
    timestamp?: string;
    duration?: string;
    summary?: { passed?: number; failed?: number; skipped?: number; warnings?: number };
    tests?: TestCase[];
    notes?: string;
    recommendations?: (string | TestStep)[];
}
