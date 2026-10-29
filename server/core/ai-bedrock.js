import { createHash } from 'node:crypto';
import { auProfile, READER_REGIONS } from './ai.js';
import { FlowError } from './errors.js';
import { authorizationHeader } from './storage.js';

// Amazon Bedrock, Converse API, Australia only. The endpoint region is
// Sydney or Melbourne and the model id is an au. inference profile, so a
// call is not sent on a global or US profile. Credentials come from the
// caller (the host secret store). Nothing here is logged: a failure keeps
// the response body out of the error.

const IMAGE_FORMAT = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

function sha256Hex(body) {
  return createHash('sha256').update(body).digest('hex');
}

function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function fail(code, { retry }) {
  const error = new FlowError(code, code === 'reader_unavailable' ? 'the reader did not answer' : 'could not read the form');
  error.retry = retry;
  return error;
}

async function drop(res) {
  await res.arrayBuffer?.().catch(() => {});
}

// The text blocks only. A thinking block is not the form, and it is not returned.
function textOf(parsed) {
  const blocks = parsed?.output?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('');
}

export function createBedrockClient({
  region, accessKeyId, secretAccessKey, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 120_000,
}) {
  if (!READER_REGIONS.includes(region)) throw new FlowError('invalid', 'reader region must be Sydney or Melbourne');
  if (!accessKeyId || !secretAccessKey) throw new FlowError('invalid', 'reader credentials are required');

  return {
    async readImage({ model, mediaType, bytes, instruction, schema, maxTokens = 4096 }) {
      if (!auProfile(model) || !IMAGE_FORMAT[mediaType] || !Buffer.isBuffer(bytes)) throw fail('reader_rejected', { retry: false });
      const payload = JSON.stringify({
        system: [{ text: 'You read one handwritten lab form. You never guess a value.' }],
        messages: [{
          role: 'user',
          content: [
            { image: { format: IMAGE_FORMAT[mediaType], source: { bytes: bytes.toString('base64') } } },
            { text: String(instruction ?? '') },
          ],
        }],
        inferenceConfig: { maxTokens },
        // Effort low keeps the read short. Thinking stays on its default:
        // Haiku 5.5 and Sonnet 5.5 do not share one way to turn it off.
        additionalModelRequestFields: { output_config: { effort: 'low' } },
        outputConfig: {
          textFormat: {
            type: 'json_schema',
            structure: {
              jsonSchema: {
                name: 'lab_form',
                description: 'Fields read from one lab form',
                schema: JSON.stringify(schema),
              },
            },
          },
        },
      });
      const at = now();
      const host = `bedrock-runtime.${region}.amazonaws.com`;
      const path = `/model/${encodeURIComponent(model)}/converse`;
      const payloadHash = sha256Hex(payload);
      const headers = {
        host,
        'content-type': 'application/json',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate(at),
      };
      const { header } = authorizationHeader({
        method: 'POST', path, headers, payloadHash, accessKeyId, secretAccessKey, region, service: 'bedrock', now: at,
      });
      const sent = { ...headers, authorization: header };
      delete sent.host;
      let res;
      try {
        res = await fetchImpl(`https://${host}${path}`, {
          method: 'POST', headers: sent, body: payload, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw fail('reader_unavailable', { retry: true });
      }
      if (!res?.ok) {
        if (res) await drop(res);
        const status = res?.status ?? 0;
        throw fail(status === 429 || status >= 500 ? 'reader_unavailable' : 'reader_rejected', {
          retry: status === 429 || status >= 500,
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
      } catch {
        throw fail('reader_unreadable', { retry: true });
      }
      const text = textOf(parsed);
      if (!text || parsed?.stopReason === 'max_tokens') throw fail('reader_unreadable', { retry: true });
      return {
        text,
        inputTokens: parsed?.usage?.inputTokens ?? 0,
        outputTokens: parsed?.usage?.outputTokens ?? 0,
      };
    },
  };
}
