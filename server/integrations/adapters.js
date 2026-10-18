// The adapters this build of Flow ships. server/index.js registers each one;
// FLOW_INTEGRATIONS chooses which are on (server/integrations/index.js).
import { seazonaAdapter } from './seazona/index.js';
import { xeroAdapter } from './xero/index.js';

export const adapters = [seazonaAdapter, xeroAdapter];
