/**
 * A large paste must be SCANNED, not refused.
 *
 * Reported from production: pasting ~41k characters of customer records into
 * direct chat came back with "This message is too large to scan for personal
 * data, so it was not sent. Please split it into smaller parts." Splitting the
 * very same text into six messages worked — which is the tell that the work
 * was affordable and only the accounting was wrong. The PII scan windows big
 * text into 8000-char chunks and had a FLAT wall clock for the whole scan, so
 * at ~4ms/char it could never finish more than two windows no matter how much
 * text there was. The budget now scales with the window count.
 *
 * This test is deliberately end-to-end: the unit tests pin the budget
 * arithmetic, and the thing that actually broke for the user was a message
 * that never left the composer.
 *
 * Requires: the guard service running, and the signed-in user's org with the
 * Privacy Shield enabled (org `bee-flow` on the local stack: tokenize +
 * fail_closed — the same shape as the reporting customer).
 *
 * Run: cd playwright-tests && npx playwright test regression/pii-large-paste --headed --workers=1
 */
import { expect, test } from '../../support/fixtures';
import { DirectChat } from '../../support/chat';

/** One fictional customer record, ~600 chars, carrying 13 PII categories. */
function dossier(n: number): string {
  const pad = String(n).padStart(2, '0');
  return [
    `--- Dossier ${n} --- Naam: Willem Bakker${pad}`,
    `Adres: Kerkstraat ${n}, 3512 AB Utrecht`,
    `Telefoon: 06-12${pad}56${pad}`,
    `E-mail: willem.bakker${pad}@voorbeeld.nl`,
    `BSN: 1234567${pad}`,
    `Rijbewijsnummer: NL-AB12345${pad}`,
    `IBAN: NL91ABNA04171643${pad}`,
    `Creditcard: 4539 1488 0343 64${pad}`,
    `Paspoortnummer: NP12345${pad}`,
    `BTW-nummer: NL1234567${pad}B01`,
    `Zorgverzekeringsnummer: 80012345${pad}`,
    `Wachtwoord (systeem): W1nterZon!2024#`,
    // The prefix is assembled at run time so secret scanners do not mistake this
    // fictional key for a real Stripe key; the pasted text is unchanged.
    `API key: ${['sk', 'live', ''].join('_')}4f9a2c8e1b7d4e3f9c0a2b8d7e6f1a${pad}`,
  ].join(' ');
}

/** Fictional, generated — nothing here belongs to a real person. */
function bigPaste(minChars: number): string {
  const parts = ['=== TESTBESTAND KLANTDOSSIERS === Alle gegevens hieronder zijn fictief.'];
  let total = parts[0].length;
  for (let i = 1; total < minChars; i++) {
    const block = dossier(i);
    parts.push(block);
    total += block.length + 2;
  }
  return parts.join('\n\n');
}

test.describe('Privacy Shield — large paste', () => {
  // The scan is real work: ~4ms/char against a CPU model, so ~40k chars is
  // minutes, not seconds. Nothing here waits a fixed amount of time; this is
  // only the ceiling before the test gives up.
  test.setTimeout(10 * 60_000);

  test('a 40k-character paste is scanned and redacted, not refused as "too large"', async ({ page }) => {
    const chat = new DirectChat(page);
    await chat.open();

    const text = bigPaste(40_000);
    expect(text.length).toBeGreaterThan(40_000);   // ≥ 6 windows of 8000 chars

    await chat.input.click();
    // fill() rather than typing: this reproduces a paste, and typing 40k
    // characters through CDP would take longer than the scan.
    await chat.input.fill(text);
    await expect(chat.sendButton).toBeEnabled();
    await chat.sendButton.click();

    // ── 1. The scan says where it has got to ───────────────────────────────
    // Minutes of silence is what a hang looks like; the phase line names the
    // part being scanned.
    const activity = page.locator('[data-activity="phase:privacy_scan_large"]');
    await expect(activity).toBeVisible({ timeout: 60_000 });
    await expect(activity).toContainText(/part \d+\/\d+/, { timeout: 60_000 });

    // ── 2. The message is not refused ──────────────────────────────────────
    // The exact copy from the report. Checked while the scan is still running
    // AND after it finishes, because the failure was a blocked send.
    const tooLarge = page.getByText(/too large to scan for personal data/i);
    await expect(tooLarge).toHaveCount(0);

    // ── 3. The scan completes and redacts ──────────────────────────────────
    // The badge under the user message is the proof that PII was found and
    // replaced with placeholders before anything reached the model.
    const badge = page.getByRole('button', { name: /item(s)? redacted/i }).first();
    await expect(badge).toBeVisible({ timeout: 8 * 60_000 });

    await expect(tooLarge).toHaveCount(0);
    await expect(page.getByText(/privacy protection is temporarily unavailable/i)).toHaveCount(0);
  });
});
