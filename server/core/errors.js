// A failure the caller can act on. `code` is stable; the API returns it.
export class FlowError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const notFound = (what) => new FlowError('not_found', `${what} not found`);
