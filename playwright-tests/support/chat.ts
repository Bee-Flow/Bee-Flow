/**
 * Page object for the direct-chat surface (`/app` → "New Chat" → `/d/:id`).
 *
 * Testids come from `agent-hub/src/components/InputArea.jsx` and
 * `components/chat/MessageItem/index.jsx`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { skipOnboardingTour } from './gates';

export class DirectChat {
  readonly page: Page;
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly stopButton: Locator;
  /** Both roles share `message-<id>`; user bubbles are `items-end`, assistant `items-start`. */
  readonly messages: Locator;
  readonly userMessages: Locator;
  readonly assistantMessages: Locator;

  constructor(page: Page) {
    this.page = page;
    this.input = page.getByTestId('chat-message-input');
    this.sendButton = page.getByTestId('send-message-button');
    this.stopButton = page.getByTestId('stop-generating-button');
    this.messages = page.locator('[data-testid^="message-"]');
    this.userMessages = page.locator('[data-testid^="message-"].items-end');
    this.assistantMessages = page.locator('[data-testid^="message-"].items-start');
  }

  /** Opens the app and starts a fresh direct conversation. */
  async open(): Promise<void> {
    await this.page.goto('/app');
    await expect(this.page.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });
    // The tour auto-starts on the chat home and its overlay eats clicks.
    await skipOnboardingTour(this.page);

    await this.page.getByTestId('nav-new-chat').click();
    await skipOnboardingTour(this.page);
    await expect(this.input).toBeVisible();
  }

  /** Types `text` and sends it with the send button. */
  async send(text: string): Promise<void> {
    await this.input.click();
    await this.input.fill(text);
    // The button is disabled until the composer has content.
    await expect(this.sendButton).toBeEnabled();
    await this.sendButton.click();
  }

  /** Sends `text` and resolves with the finished assistant message. */
  async sendAndWaitForReply(text: string, timeout = 90_000): Promise<Locator> {
    await this.send(text);
    return this.waitForReply(timeout);
  }

  /**
   * Waits for the streamed reply to finish. While generating, the send button
   * is replaced by the stop button; the reply is done when send is back.
   */
  async waitForReply(timeout = 90_000): Promise<Locator> {
    // Best-effort: on a very fast reply the stop button can come and go
    // between polls, so never fail the test on this alone.
    await this.stopButton.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    await expect(this.stopButton).toBeHidden({ timeout });
    await expect(this.sendButton).toBeVisible({ timeout: 15_000 });
    return this.assistantMessages.last();
  }
}
