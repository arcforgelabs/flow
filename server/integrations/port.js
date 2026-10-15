// The integration port: the one contract between the Flow core and every
// adapter (Seazona, Xero, and later ones). The core calls only the
// capabilities an adapter declares, and never imports an adapter directly.
// VISION.md, "The core and its integrations".

export const CAPABILITIES = Object.freeze([
  'pullWorkItems', // billable work since a cursor (Seazona: completed cases)
  'pushInvoice', // send an issued invoice; the Flow record id is the idempotency key
  'pushBill', // send an approved bill; the Flow record id is the idempotency key
  'pullPayments', // payments since a cursor, matched to invoices and bills
  'health', // connection state for Settings
]);

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function defineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('An adapter must be an object');
  }
  const { id, name, bundled = false, capabilities } = adapter;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(`Adapter id must match ${ID_PATTERN}`);
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError(`Adapter ${id} needs a name`);
  }
  if (!capabilities || typeof capabilities !== 'object') {
    throw new TypeError(`Adapter ${id} declares no capabilities`);
  }
  for (const [key, fn] of Object.entries(capabilities)) {
    if (!CAPABILITIES.includes(key)) {
      throw new TypeError(`Adapter ${id} declares unknown capability ${key}`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`Adapter ${id} capability ${key} must be a function`);
    }
  }
  if (typeof capabilities.health !== 'function') {
    throw new TypeError(`Adapter ${id} must declare health`);
  }
  return Object.freeze({ id, name, bundled: Boolean(bundled), capabilities: Object.freeze({ ...capabilities }) });
}

export function createRegistry() {
  const adapters = new Map();
  const enabled = new Set();

  return {
    register(adapter) {
      const defined = defineAdapter(adapter);
      if (adapters.has(defined.id)) {
        throw new Error(`Adapter ${defined.id} is already registered`);
      }
      adapters.set(defined.id, defined);
      return defined;
    },
    enable(id) {
      if (!adapters.has(id)) throw new Error(`No adapter ${id}`);
      enabled.add(id);
    },
    disable(id) {
      enabled.delete(id);
    },
    list() {
      return [...adapters.values()].map((a) => ({
        id: a.id,
        name: a.name,
        bundled: a.bundled,
        enabled: enabled.has(a.id),
        capabilities: Object.keys(a.capabilities),
      }));
    },
    // The enabled adapters that declare one capability. The core fans out to
    // these and nothing else, so a disabled adapter changes nothing.
    with(capability) {
      if (!CAPABILITIES.includes(capability)) {
        throw new TypeError(`Unknown capability ${capability}`);
      }
      return [...enabled]
        .map((id) => adapters.get(id))
        .filter((a) => typeof a.capabilities[capability] === 'function');
    },
  };
}
