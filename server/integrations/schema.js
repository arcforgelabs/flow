import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// An adapter's tables: created from its own migrations while it is enabled,
// never dropped by turning it off. Each adapter keeps its own migration
// journal (drizzle.__drizzle_migrations_<id>), so the core's journal and
// every other adapter's stay independent. docs/INTEGRATIONS.md.

const MISSING_TABLE = '42P01'; // PostgreSQL undefined_table

export function migrationsTable(adapter) {
  return `__drizzle_migrations_${adapter.id.replaceAll('-', '_')}`;
}

// The adapter's declared tables that do not exist.
export async function missingAdapterTables(db, adapter) {
  const missing = [];
  for (const table of adapter.schema.tables) {
    const { rows } = await db.execute(sql`select to_regclass(${`public.${table}`}) is null as missing`);
    if (rows[0].missing) missing.push(table);
  }
  return missing;
}

// Runs the adapter's pending migrations, then checks they created every table
// it declares, so the declaration stays true.
export async function migrateAdapterSchema(db, adapter) {
  await migrate(db, { migrationsFolder: adapter.schema.migrationsFolder, migrationsTable: migrationsTable(adapter) });
  const missing = await missingAdapterTables(db, adapter);
  if (missing.length) {
    throw new Error(`Adapter ${adapter.id} migrations did not create ${missing.join(', ')}`);
  }
}

export function isMissingTable(error) {
  return error?.code === MISSING_TABLE || error?.cause?.code === MISSING_TABLE;
}

// The separate, explicit step that removes a turned-off adapter's tables. It
// refuses while the adapter is enabled and while any of its tables holds a
// row, so it never removes data. Everything goes in one transaction.
export async function removeAdapterTables(db, adapter, { enabled }) {
  if (!adapter.schema) return { removed: [] };
  if (enabled) throw new Error(`Turn ${adapter.name} off before removing its tables`);
  const missing = new Set(await missingAdapterTables(db, adapter));
  const present = adapter.schema.tables.filter((table) => !missing.has(table));
  return db.transaction(async (tx) => {
    const holding = [];
    for (const table of present) {
      const { rows } = await tx.execute(sql`select exists (select 1 from ${sql.identifier(table)}) as holding`);
      if (rows[0].holding) holding.push(table);
    }
    if (holding.length) {
      throw new Error(`${adapter.name} tables still hold rows: ${holding.join(', ')}. Nothing was removed.`);
    }
    if (present.length) {
      await tx.execute(sql`drop table ${sql.join(present.map((t) => sql.identifier(t)), sql`, `)}`);
    }
    await tx.execute(sql`drop table if exists ${sql.identifier('drizzle')}.${sql.identifier(migrationsTable(adapter))}`);
    return { removed: present };
  });
}
