#!/usr/bin/env node
import { createApp } from './app.js';
import { migrateDatabase, openDatabase } from './db/index.js';

const port = Number(process.env.FLOW_PORT || process.env.PORT || 19300);

// Flow's records live in PostgreSQL. Migrations run before the server accepts
// requests, so a release never serves an older schema.
const database = openDatabase();
await migrateDatabase(database.db);

createApp({ database }).listen(port, () => {
  console.log(`[flow] listening on ${port}`);
});
