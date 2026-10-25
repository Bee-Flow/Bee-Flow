// The docs build must fail on a broken link, anchor or markdown link: nobody may quietly set them back to 'warn'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('./docusaurus.config.ts', import.meta.url), 'utf8');

for (const key of ['onBrokenLinks', 'onBrokenAnchors', 'onBrokenMarkdownLinks']) {
  test(`${key} is 'throw'`, () => {
    const m = config.match(new RegExp(`${key}:\\s*'(\\w+)'`));
    assert.ok(m, `${key} is not set in docusaurus.config.ts`);
    assert.equal(m[1], 'throw');
  });
}
