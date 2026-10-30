export class ApiError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
