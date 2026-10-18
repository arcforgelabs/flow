import { defineConfig } from 'drizzle-kit';

// The Seazona adapter's own migrations (docs/SEAZONA.md, "Tables"). Generate
// with: npx drizzle-kit generate --config server/integrations/seazona/drizzle.config.js
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/integrations/seazona/schema.js',
  out: './server/integrations/seazona/migrations',
});
