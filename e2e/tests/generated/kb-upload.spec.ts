// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Edit e2e/scenarios/kb-upload.md and run: npm run gen -- kb-upload
// scenario-hash: sha256:880350e41b0d2e88708b10a095ff961ea49eeed53a025d3dac260b1436220491
// prompt-version: 1  app-map-hash: sha256:73981cb46fe0  model: hand-written (no ANTHROPIC_API_KEY in this environment)
import * as path from 'path';
import { test, expect, AUTH_FILE } from '../fixtures';

test.use({ storageState: AUTH_FILE });

const FIXTURE_FILE = path.join(__dirname, '..', '..', 'fixtures-data', 'sample.md');
const DONE = /^(processed|redacted)$/;

test('kb-upload: A knowledge base ingests an uploaded document', async ({ page, runId }) => {
  test.setTimeout(150_000);
  const kbName = `E2E KB ${runId}`;

  await page.goto('/app/studio/knowledge');

  // One click makes the base AND opens it — there is no create form.
  await page.getByTestId('kb-create').click();
  await expect(page).toHaveURL(/\/app\/studio\/knowledge\/[^/?#]+\/sources/, { timeout: 30_000 });

  const detail = page.getByTestId('kb-detail-page');
  await expect(detail).toBeVisible();
  const kbId = new URL(page.url()).pathname.split('/')[4];

  try {
    // Rename through the header: the title is a button that swaps in an input.
    await detail.getByTestId('studio-section-title').click();
    const nameInput = detail.getByTestId('studio-section-title-input');
    await nameInput.fill(kbName);
    await nameInput.press('Enter');
    await expect(detail.getByTestId('studio-section-title')).toHaveText(kbName);

    // Upload: the kind button opens the form, the file input is labelled
    // "Choose files" and the upload starts on pick (server answers 202).
    await detail.getByTestId('kb-add-kind-upload').click();
    await detail.getByLabel('Choose files', { exact: true }).setInputFiles(FIXTURE_FILE);

    // The source row appears as soon as the upload is accepted.
    const sourceRow = detail.getByTestId('kb-source-row').first();
    await expect(sourceRow).toBeVisible({ timeout: 60_000 });
    await sourceRow.click();

    const source = page.getByTestId('kb-source-detail');
    await expect(source).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/app\/studio\/knowledge\/[^/?#]+\/sources\/[^/?#]+/);

    // Ingestion is asynchronous and the list polls itself; the document row's
    // data-status is the completion signal. "redacted" means Privacy Shield
    // replaced something in it — it was still ingested. Never wait on text.
    const docRow = source.getByTestId('kb-doc-row').first();
    await expect(docRow).toBeVisible({ timeout: 90_000 });
    await expect(docRow).toHaveAttribute('data-status', DONE, { timeout: 120_000 });
  } finally {
    // Clean up even when an assertion above failed. Deleting the base takes
    // its sources and documents with it. This is the in-app danger zone, not
    // a native confirm — a page.on('dialog') handler would never fire here.
    await page.goto(`/app/studio/knowledge/${kbId}/settings`);
    const danger = page.getByTestId('danger-zone');
    await danger.getByRole('button', { name: 'Delete this knowledge base' }).click();
    // The name field only appears when something still uses the base or the
    // usage list has not loaded; a freshly made base usually skips it.
    const typeName = danger.getByLabel('Type the name to confirm.');
    if (await typeName.count()) await typeName.fill(kbName);
    await danger.getByRole('button', { name: 'Delete for good' }).click();
    await expect(page).toHaveURL(/\/app\/studio\/knowledge(?:$|[?#])/, { timeout: 30_000 });
    await expect(page.getByTestId('kb-overview').getByText(kbName)).toHaveCount(0);
  }
});
