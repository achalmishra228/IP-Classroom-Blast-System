/** An error that carries an HTTP status and a message that is safe to show to the client. */
export class HttpError extends Error {
  constructor(status, message, fields = null) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export function firstError(errors) {
  return Object.values(errors)[0];
}

/** Throws a 400 if `errors` has any entries. */
export function assertValid(errors) {
  if (Object.keys(errors).length > 0) {
    throw new HttpError(400, firstError(errors), errors);
  }
}
