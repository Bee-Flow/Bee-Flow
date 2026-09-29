---
description: How to safely update the PostgreSQL database schema
---
# Updating PostgreSQL Schema in BeeFlow

BeeFlow does not use a third-party migration tool like Prisma or TypeORM. It uses built-in automatic structure updates inside the Stores on server boot or migration run.

1. **Locate the Store**: Find the relevant store file in `server/stores/` (e.g. `userStore.js`).
2. **Update the CREATE Query**: Inside the store, there is a `pool.query()` call near the top of the file that creates the table (e.g. `CREATE TABLE IF NOT EXISTS ...`). Add any new columns to this query for fresh installs.
3. **Add ALTER TABLE Fallbacks**: Right below the `CREATE TABLE` script, ensure there is an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` query. This is crucial because `CREATE TABLE IF NOT EXISTS` will not alter existing tables to add columns.
4. **Verify Store Runner**: Make sure the store is listed in the `STORE_MODULES` array in `server/migrateDb.js`.
5. **Trigger Migration**: The `server/migrateDb.js` script loops through all stores and runs their queries sequentially. Running `node migrateDb.js` inside the `server` folder or `npm run start` will execute the queries and update the schema automatically.
