/** Base class for every error thrown by the SDK. */
export class VinoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A non-2xx HTTP response. Carries the HTTP status and, when present, the
 * server's `{"error":"..."}` message.
 */
export class VinoHttpError extends VinoError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * A failure after the run stream opened: either a terminal SSE `error` event
 * or a stream that ended before `run_finished`.
 */
export class VinoStreamError extends VinoError {}
