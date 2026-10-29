import { FlowError } from './errors.js';
import { SURE_LINE } from '../ui/capture-fields.js';

// The AI port. One call reads one image and returns text. The vision reader
// (server/core/reader.js) is the caller. A client implements readImage; this
// file does not name a vendor.
//
// The model id and the region come from the environment (resolveReader).
// A model id that is not an Australia inference profile (au.) is refused
// before any call. An error that leaves this port has a fixed message, so a
// log never receives the photo or the model's answer.

export const READER_REGIONS = Object.freeze(['ap-southeast-2', 'ap-southeast-4']);

// USD micros per million tokens for the Australia profile: Anthropic's list
// price plus 10% (October 2026). Haiku 5.5 uses the long rate when the
// prompt is over 100,000 tokens. An operator sets FLOW_READER_*_MICROS_PER_MILLION
// when the model id is not listed here, or when the price changes.
const AU_MICROS = Object.freeze({
  'au.anthropic.claude-haiku-5-5': Object.freeze({
    input: 110_000, output: 550_000, longInput: 550_000, longOutput: 2_750_000, longFrom: 100_000,
  }),
  'au.anthropic.claude-sonnet-5-5': Object.freeze({ input: 2_200_000, output: 11_000_000 }),
});

const PROFILE = /^au\.[a-z0-9][a-z0-9._:-]{0,127}$/;

export function auProfile(id) {
  return typeof id === 'string' && PROFILE.test(id) && !id.includes('..');
}

// Integer micros for one call. Null when this model has no price: the tokens
// are still recorded, and the cost is not a guess.
export function callCostMicros({ inputTokens, outputTokens, price }) {
  if (!price || !Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) return null;
  if (inputTokens < 0 || outputTokens < 0) return null;
  const long = Number.isInteger(price.longFrom) && inputTokens > price.longFrom;
  const input = long ? price.longInput : price.input;
  const output = long ? price.longOutput : price.output;
  if (!Number.isInteger(input) || !Number.isInteger(output)) return null;
  return Math.round((inputTokens * input + outputTokens * output) / 1_000_000);
}

const MESSAGES = Object.freeze({
  reader_unavailable: 'the reader did not answer',
  reader_rejected: 'could not read the form',
  reader_unreadable: 'could not read the form',
});

function clean(error) {
  const code = MESSAGES[error?.code] ? error.code : 'reader_unavailable';
  const next = new FlowError(code, MESSAGES[code]);
  next.retry = error?.retry !== false && code !== 'reader_rejected';
  return next;
}

export function createAiPort(client) {
  if (typeof client?.readImage !== 'function') throw new TypeError('an AI port needs readImage');
  return {
    async readImage(request) {
      if (!auProfile(request?.model) || !Buffer.isBuffer(request?.bytes) || request.bytes.length === 0) {
        const error = new FlowError('reader_rejected', MESSAGES.reader_rejected);
        error.retry = false;
        throw error;
      }
      try {
        const result = await client.readImage(request);
        const inputTokens = Number(result?.inputTokens);
        const outputTokens = Number(result?.outputTokens);
        return {
          model: request.model,
          text: typeof result?.text === 'string' ? result.text : '',
          inputTokens: Number.isInteger(inputTokens) && inputTokens >= 0 ? inputTokens : 0,
          outputTokens: Number.isInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
        };
      } catch (error) {
        throw clean(error);
      }
    },
  };
}

function readMicros(raw, name) {
  if (raw == null || String(raw).trim() === '') return null;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of micros per million tokens`);
  return value;
}

function priceFrom(env, model, prefix) {
  const input = readMicros(env[`${prefix}_INPUT_MICROS_PER_MILLION`], `${prefix}_INPUT_MICROS_PER_MILLION`);
  const output = readMicros(env[`${prefix}_OUTPUT_MICROS_PER_MILLION`], `${prefix}_OUTPUT_MICROS_PER_MILLION`);
  if (input == null && output == null) return AU_MICROS[model] ?? null;
  if (input == null || output == null) {
    throw new Error(`${prefix}_INPUT_MICROS_PER_MILLION and ${prefix}_OUTPUT_MICROS_PER_MILLION are set together`);
  }
  return { input, output };
}

function sureLineOf(env) {
  const raw = String(env.FLOW_READER_SURE_LINE ?? '').trim();
  if (!raw) return SURE_LINE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('FLOW_READER_SURE_LINE must be a number from 0 to 1');
  return value;
}

// Answers the reader settings. `on` is false when the module is off or the
// keys are missing: a capture is then a problem a person can type. A region
// outside Sydney and Melbourne, or a model id that is not an au. profile,
// stops boot rather than sending a form there.
export function resolveReader({ env = process.env } = {}) {
  const flag = String(env.FLOW_READER ?? '').trim().toLowerCase();
  if (flag && flag !== 'on' && flag !== 'off') throw new Error('FLOW_READER must be "on", "off" or unset');
  if (flag !== 'on') return { on: false, reason: flag === 'off' ? 'off' : 'unset' };

  const region = String(env.FLOW_READER_REGION ?? '').trim();
  const model = String(env.FLOW_READER_MODEL ?? '').trim();
  const large = String(env.FLOW_READER_MODEL_LARGE ?? '').trim();
  if (!READER_REGIONS.includes(region)) {
    throw new Error('FLOW_READER=on needs FLOW_READER_REGION set to ap-southeast-2 (Sydney) or ap-southeast-4 (Melbourne)');
  }
  if (!model || !large) throw new Error('FLOW_READER=on needs FLOW_READER_MODEL and FLOW_READER_MODEL_LARGE');
  if (!auProfile(model) || !auProfile(large)) {
    throw new Error('FLOW_READER_MODEL and FLOW_READER_MODEL_LARGE must be au. inference profiles');
  }
  const accessKeyId = String(env.FLOW_READER_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = String(env.FLOW_READER_SECRET_ACCESS_KEY ?? '').trim();
  if (!accessKeyId || !secretAccessKey) return { on: false, reason: 'no_credentials' };

  return {
    on: true,
    reason: null,
    region,
    model,
    large,
    accessKeyId,
    secretAccessKey,
    sureLine: sureLineOf(env),
    prices: {
      small: priceFrom(env, model, 'FLOW_READER'),
      large: priceFrom(env, large, 'FLOW_READER_LARGE'),
    },
  };
}
