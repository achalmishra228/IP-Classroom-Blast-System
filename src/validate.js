const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PRIORITIES = ['normal', 'important'];

export const LIMITS = {
  nameMin: 2,
  nameMax: 60,
  emailMax: 254,
  passwordMin: 8,
  passwordMaxBytes: 72, // bcrypt only uses the first 72 bytes
  subjectMax: 80,
  messageMax: 1000,
  queryMax: 100,
};

const isString = (value) => typeof value === 'string';
const asObject = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const collapseSpaces = (text) => text.replace(/\s+/g, ' ').trim();

/** Sign-up and "create admin" input. */
export function validateAccount(body) {
  const input = asObject(body);
  const errors = {};

  const name = isString(input.name) ? collapseSpaces(input.name) : '';
  const email = isString(input.email) ? input.email.trim().toLowerCase() : '';
  const password = isString(input.password) ? input.password : '';

  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) {
    errors.name = `Name must be ${LIMITS.nameMin} to ${LIMITS.nameMax} characters.`;
  }
  if (!email || email.length > LIMITS.emailMax || !EMAIL_RE.test(email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (password.length < LIMITS.passwordMin) {
    errors.password = `Password must be at least ${LIMITS.passwordMin} characters.`;
  } else if (Buffer.byteLength(password) > LIMITS.passwordMaxBytes) {
    errors.password = `Password is too long (max ${LIMITS.passwordMaxBytes} bytes).`;
  }

  return { value: { name, email, password }, errors };
}

export function validateLogin(body) {
  const input = asObject(body);
  const errors = {};

  const email = isString(input.email) ? input.email.trim().toLowerCase() : '';
  const password = isString(input.password) ? input.password : '';

  if (!email) errors.email = 'Enter your email address.';
  if (!password) errors.password = 'Enter your password.';

  return { value: { email, password }, errors };
}

/**
 * Announcement input. With `partial: true` (PATCH) only the fields that are present are checked.
 */
export function validateAnnouncement(body, { partial = false } = {}) {
  const input = asObject(body);
  const errors = {};
  const value = {};

  if (!partial || 'subject' in input) {
    const subject = isString(input.subject) ? collapseSpaces(input.subject) : '';
    if (!subject || subject.length > LIMITS.subjectMax) {
      errors.subject = `Subject is required (max ${LIMITS.subjectMax} characters).`;
    } else {
      value.subject = subject;
    }
  }

  if (!partial || 'message' in input) {
    const message = isString(input.message) ? input.message.replace(/\r\n/g, '\n').trim() : '';
    if (!message || message.length > LIMITS.messageMax) {
      errors.message = `Announcement is required (max ${LIMITS.messageMax} characters).`;
    } else {
      value.message = message;
    }
  }

  if ('priority' in input || !partial) {
    const priority = input.priority === undefined && !partial ? 'normal' : input.priority;
    if (!PRIORITIES.includes(priority)) {
      errors.priority = 'Priority must be "normal" or "important".';
    } else {
      value.priority = priority;
    }
  }

  if (partial && Object.keys(errors).length === 0 && Object.keys(value).length === 0) {
    errors.body = 'Nothing to update.';
  }

  return { value, errors };
}
