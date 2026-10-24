'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isMicrosoftDownloadUrl } = require('./oneDrive');

test('only Microsoft https download hosts are accepted', () => {
    assert.equal(isMicrosoftDownloadUrl('https://contoso-my.sharepoint.com/personal/x/_layouts/15/download.aspx?UniqueId=1'), true);
    assert.equal(isMicrosoftDownloadUrl('https://public.bn.files.1drv.com/y4m'), true);
});

test('metadata, private, lookalike and non-https URLs are refused', () => {
    for (const u of [
        'http://169.254.169.254/latest/meta-data/',
        'https://10.0.0.5/x',
        'https://evil.com/sharepoint.com',
        'https://sharepoint.com.evil.com/x',
        'https://notsharepoint.com/x',
        'http://contoso.sharepoint.com/x',
        'https://user:pw@contoso.sharepoint.com/x',
        'not a url',
    ]) assert.equal(isMicrosoftDownloadUrl(u), false, u);
});
