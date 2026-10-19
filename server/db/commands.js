import { adapters } from '../integrations/adapters.js';
import { diagnoseDatabase, formatReport, liveMigrationCounts, publishVerdict } from './doctor.js';
import { openDatabase } from './index.js';
import { migrateEverything } from './migrate-all.js';

// `flow-server migrate` and `flow-server doctor` (server/flow-server.js).
// Each returns the exit code.
export async function runCommand(command, args, { log = console } = {}) {
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  let handle;
  try {
    handle = openDatabase({ max: 1 });
  } catch (error) {
    log.error(`[doctor] ${error.message}`);
    return 2;
  }
  try {
    if (command === 'migrate') {
      await migrateEverything(handle.db, { log: (line) => log.log(`[migrate] ${line}`) });
      log.log('[migrate] the database is at this build');
      return 0;
    }
    const report = await diagnoseDatabase(handle.pool, { adapters });
    const origin = option('--live');
    const live = origin ? await liveMigrationCounts(origin) : undefined;
    const verdict = origin ? publishVerdict(report, live) : null;
    if (args.includes('--json')) {
      log.log(JSON.stringify({ ...report, live: live ?? null, verdict }, null, 2));
    } else {
      for (const line of formatReport(report, verdict)) log.log(`[doctor] ${line}`);
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    log.error(`[doctor] ${error.message}`);
    return 2;
  } finally {
    await handle.close();
  }
}
