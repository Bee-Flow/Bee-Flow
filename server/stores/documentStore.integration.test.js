'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('PostgreSQL: upgrade legacy documents, immutable pins, sharing, conflict and folders', {skip:!process.env.DOCUMENT_TEST_DATABASE_URL}, async () => {
    // Explicit opt-in only. Use a disposable PostgreSQL instance; this test creates
    // a dedicated database and drops only that database after closing its pools.
    const { Pool } = require('pg');
    const admin = new Pool({connectionString:process.env.DOCUMENT_TEST_DATABASE_URL});
    const database='document_test_'+require('crypto').randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${database}`);
    const url=new URL(process.env.DOCUMENT_TEST_DATABASE_URL);url.pathname='/'+database;
    process.env.CORE_DATABASE_URL=url.toString();
    process.env.MASTER_ENCRYPTION_KEY='document-integration-test-only-key';
    const db=require('../db');
    try {
        await db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,"organizationId" TEXT);
            INSERT INTO users VALUES ('owner','org-a'),('colleague','org-a'),('outsider','org-b');
            CREATE TABLE studio_documents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT,doc_type TEXT,description TEXT,body_html TEXT,css TEXT,settings JSONB,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
            INSERT INTO studio_documents(id,user_id,name,doc_type,description,body_html,css,settings) VALUES ('legacy','owner','Legacy','letter','','<p>{{name}}</p>','.old{}','{}');
            CREATE TABLE studio_document_versions(id TEXT PRIMARY KEY, document_id TEXT REFERENCES studio_documents(id),summary TEXT,body_html TEXT,css TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
            INSERT INTO studio_document_versions VALUES ('old-history','legacy','Legacy edit','<p>Older text</p>','.older{}',NOW());`);
        const houseStyle=require('../core/documents/documentHouseStyle');
        await houseStyle.setHouseStyle('org-a',{enabled:true,accent:'#112233'});
        const store=require('./documentStore');await store.initDB();
        const legacy=await store.getDocument('legacy','owner');
        assert.equal(legacy.bodyHtml,'<p>{{name}}</p>');assert.equal(legacy.organizationId,'org-a');
        assert.equal(legacy.baselineVersionId,'baseline-legacy');
        await houseStyle.setHouseStyle('org-a',{enabled:true,accent:'#445566'});
        const baseline=await store.getDocumentVersion('legacy','owner');
        assert.match(baseline.settings.resolvedHouseStyleCss,/#112233/);
        assert.doesNotMatch(baseline.settings.resolvedHouseStyleCss,/#445566/);
        const history=await store.getDocumentVersion('legacy','owner','old-history');
        assert.equal(history.bodyHtml,'<p>Older text</p>');assert.equal(history.css,'.older{}');
        const edited=await store.updateDocument('legacy','owner',{bodyHtml:'<p>Edited</p>',expectedVersionId:legacy.versionId});
        assert.notEqual(edited.versionId,legacy.versionId);
        const old=await store.getDocumentVersion('legacy','owner');
        assert.equal(old.bodyHtml,legacy.bodyHtml);assert.equal(old.css,'.old{}');
        assert.equal(typeof old.settings.resolvedHouseStyleCss,'string');
        await assert.rejects(store.updateDocument('legacy','owner',{bodyHtml:'lost',expectedVersionId:legacy.versionId}),e=>e.status===409);
        assert.equal((await store.getDocument('legacy','owner')).bodyHtml,'<p>Edited</p>');
        const team=await store.createDocument({userId:'owner',name:'Team policy',kind:'template',visibility:'team',bodyHtml:'<p>Policy</p>',settings:{sampleValues:{secret:'must not be shared'}}});
        assert.equal(team.settings.sampleValues,undefined);
        assert.equal((await store.getDocument(team.id,'colleague')).id,team.id);
        assert.equal(await store.getDocument(team.id,'outsider'),null);
        assert.equal(await store.getDocument('legacy','colleague'),null);
        assert.equal(await store.updateDocument(team.id,'colleague',{name:'No'}),null);
        assert.equal(await store.updateDocument(team.id,{userId:'outsider',isAdmin:true},{name:'No'}),null);
        const revised=await store.updateDocument(team.id,{userId:'colleague',isAdmin:true},{bodyHtml:'<p>Reviewed policy</p>',expectedVersionId:team.versionId});
        assert.equal(revised.bodyHtml,'<p>Reviewed policy</p>');
        assert.equal((await store.getDocumentVersion(team.id,'colleague',team.versionId)).bodyHtml,'<p>Policy</p>');
        const parent=await store.createFolder('owner','Customers');const child=await store.createFolder('owner','A',parent.id);
        const doc=await store.createDocument({userId:'owner',name:'Customer A',folderId:child.id,categories:['Security']});
        await store.deleteFolder('owner',child.id);
        assert.equal((await store.getDocument(doc.id,'owner')).folderId,parent.id);
        assert.equal((await store.listDocuments('owner',{query:'Customer A',category:'Security',folderId:parent.id})).length,1);
        await store.deleteDocument(team.id,'owner');
        assert.ok(await store.getDocumentVersion(team.id,'colleague',team.versionId),'archiving preserves approved pins');
        assert.equal((await store.listDocuments('colleague',{query:'Team policy'})).length,0);
        const restored=await store.restoreVersion('legacy','owner',legacy.versionId,{expectedVersionId:edited.versionId});
        assert.equal(restored.current.bodyHtml,legacy.bodyHtml);
        assert.equal((await store.listVersions('legacy','owner')).versions.length,4);
        await db.run('UPDATE users SET "organizationId"=$1 WHERE id=$2',['org-b','owner']);
        assert.equal(await store.getDocument('legacy','owner'),null,'moving accounts cannot retain access to another organization');
    } finally {
        const configPath=require.resolve('./configStore');
        if(require.cache[configPath]) await require('./configStore')._stopInvalidationListener();
        await db.pool.end();db.disconnectRedis();
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);await admin.end();
    }
});
