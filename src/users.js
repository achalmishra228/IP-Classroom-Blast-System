import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

/** The only user fields that are ever sent to a browser. Never includes the password hash. */
export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/** Builds a user record with a hashed password. Does not save it. */
export async function buildUser({ name, email, password }, role, rounds) {
  return {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: await bcrypt.hash(password, rounds),
    role,
    createdAt: new Date().toISOString(),
  };
}
