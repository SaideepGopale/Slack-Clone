/**
 * Shared HTTP error carrying a status code, understood by
 * middleware/error.middleware.ts. New modules use this one; the per-service
 * copies of the same class predate it and are consolidated in Batch 3/E.
 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
