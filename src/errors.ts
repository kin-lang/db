/** Failure raised by the KinSQL parser or the in-memory engine. */
export class KinDbError extends Error {
  readonly code: string;
  /** True when the parser hit EOF while a statement was still open. */
  readonly incomplete: boolean;

  constructor(code: string, message: string, incomplete = false) {
    super(message);
    this.name = 'KinDbError';
    this.code = code;
    this.incomplete = incomplete;
  }
}

export function isKinDbError(error: unknown): error is KinDbError {
  return error instanceof KinDbError;
}
