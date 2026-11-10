import { sign as signBytes } from 'node:crypto';
import { OPERATIONS, operationRevision } from '../../server/core/operations.js';
import { canonicalRequest } from '../../server/core/connector-auth.js';

export const FLOW_TOOLS = OPERATIONS.filter((operation) => operation.connector).map((operation) => ({
  operation: operation.id,
  name: 'flow_' + operation.id.replace('.', '_').replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
}));

export const FLOW_PAGE = {
  id: 'flow',
  title: 'Flow',
  tools: FLOW_TOOLS.map((tool) => tool.name),
};

// The plugin refuses to call Flow when the pinned version or operation list differs.
export function createFlowClient({
  baseUrl,
  keyId,
  privateKey,
  flowVersion,
  operationRevision: pinnedRevision = operationRevision(),
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  if (!flowVersion) throw new Error('Pin the Flow version.');
  if (pinnedRevision !== operationRevision()) throw new Error('The pinned Flow operation list does not match this plugin.');

  async function call(operation, input = {}, { method = 'POST', path = `/api/flow/v1/operations/${operation}` } = {}) {
    const known = FLOW_TOOLS.some((tool) => tool.operation === operation);
    if (!known && operation !== 'flow.status') throw new Error('That operation is not in this Flow slice.');
    const body = method === 'GET' ? '' : JSON.stringify(input);
    const timestamp = Math.floor(now() / 1000);
    const signature = signBytes(null, Buffer.from(canonicalRequest({ method, path, timestamp, body })), privateKey).toString('base64');
    const response = await fetchImpl(baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-flow-key-id': keyId,
        'x-flow-timestamp': String(timestamp),
        'x-flow-signature': signature,
      },
      body: body || undefined,
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || 'Flow refused the connector request.');
    }
    if (payload.flowVersion !== flowVersion || payload.operationRevision !== pinnedRevision) {
      throw new Error('Flow version does not match this plugin.');
    }
    return payload;
  }

  return {
    page: FLOW_PAGE,
    tools: FLOW_TOOLS,
    status: () => call('flow.status', {}, { method: 'GET', path: '/api/flow/v1' }),
    run: (operation, input) => call(operation, input),
  };
}

export function registerFlowPlugin(api, client) {
  for (const tool of client.tools) {
    api.registerTool({
      name: tool.name,
      description: `Run Flow operation ${tool.operation}.`,
      parameters: { type: 'object', additionalProperties: true },
      async execute(_id, input) {
        return client.run(tool.operation, input);
      },
    });
  }
  api.registerPage?.(client.page);
}
