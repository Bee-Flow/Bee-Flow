/**
 * Page object for the search overlay (`components/SearchOverlay.jsx`).
 *
 * Opened with Ctrl/Cmd+K. Note for anyone reading BFSF-179: the shortcut in
 * that ticket (Ctrl+Alt+R) never existed in the app — Ctrl+K is the real one.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class SearchOverlay {
  readonly page: Page;
  readonly root: Locator;
  readonly input: Locator;
  readonly results: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId('search-overlay');
    this.input = page.getByTestId('search-input');
    this.results = page.locator('[data-testid^="search-result-"]');
  }

  async open(): Promise<void> {
    await this.page.keyboard.press('Control+k');
    await expect(this.root).toBeVisible();
    await expect(this.input).toBeVisible();
  }

  async close(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect(this.root).toBeHidden();
  }

  /**
   * Types `term` and waits for the debounced result list to settle on
   * `expectedCount` hits. Returns the result ids in displayed order — that
   * ordering is what BFSF-179 is about, so it must come from the DOM order.
   */
  async search(term: string, expectedCount: number, timeout = 20_000): Promise<string[]> {
    await this.input.fill(term);
    await expect(this.results).toHaveCount(expectedCount, { timeout });
    return this.resultIds();
  }

  async resultIds(): Promise<string[]> {
    return this.results.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-testid') || ''),
    );
  }
}
