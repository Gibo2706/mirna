export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const conflict = (code: string, message: string): HttpError =>
  new HttpError(409, code, message);

export const forbidden = (code: string, message: string): HttpError =>
  new HttpError(403, code, message);

export const notFound = (): HttpError =>
  new HttpError(404, 'RESOURCE_NOT_FOUND', 'Resource was not found.');

export const unauthorized = (): HttpError =>
  new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
