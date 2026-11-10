import { createFlowClient, registerFlowPlugin } from './client.js';

// OpenClaw loads this feature plugin. It does not open SQL and it does not start Flow.
export default function register(api) {
  const config = api.pluginConfig ?? api.config ?? {};
  const client = createFlowClient({
    baseUrl: config.baseUrl,
    keyId: config.keyId,
    privateKey: config.privateKey,
    flowVersion: config.flowVersion,
    operationRevision: config.operationRevision,
  });
  registerFlowPlugin(api, client);
}
