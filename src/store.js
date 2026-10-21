import fs from 'node:fs/promises';
import path from 'node:path';

const emptyData = () => ({ users: [], announcements: [], sessions: [] });

/**
 * Keeps all data in memory and saves it to one JSON file after every change.
 *
 * Writes go to a temporary file first and are then renamed over the real file,
 * so a crash in the middle of a save cannot leave a half-written database.
 * This is meant for a single server process and a small classroom, not heavy traffic.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = emptyData();
    this.queue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });

    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.save(); // first run: create the file
      return;
    }

    try {
      this.data = { ...emptyData(), ...JSON.parse(raw) };
    } catch (err) {
      // Refuse to start rather than overwrite a damaged file with an empty database.
      throw new Error(`Database file ${this.file} is not valid JSON (${err.message}). Fix or restore it, then restart.`);
    }
  }

  /** Writes the current data to disk. Saves are queued so they never overlap. */
  save() {
    const text = JSON.stringify(this.data, null, 2);
    const task = this.queue.then(() => this.#write(text));
    this.queue = task.catch(() => {});
    return task;
  }

  /** Resolves once every queued save has finished. */
  async flush() {
    await this.queue;
  }

  async #write(text) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  // ---- users ----
  getUserByEmail(email) {
    return this.data.users.find((user) => user.email === email);
  }

  getUserById(id) {
    return this.data.users.find((user) => user.id === id);
  }

  addUser(user) {
    this.data.users.push(user);
  }

  hasAdmin() {
    return this.data.users.some((user) => user.role === 'admin');
  }

  // ---- sessions (only a SHA-256 hash of the token is stored) ----
  addSession(session) {
    this.data.sessions.push(session);
  }

  getSession(tokenHash) {
    return this.data.sessions.find((session) => session.tokenHash === tokenHash);
  }

  removeSession(tokenHash) {
    this.data.sessions = this.data.sessions.filter((session) => session.tokenHash !== tokenHash);
  }

  purgeExpiredSessions(now = Date.now()) {
    this.data.sessions = this.data.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  }

  // ---- announcements (kept in the order they were created) ----
  addAnnouncement(announcement) {
    this.data.announcements.push(announcement);
  }

  getAnnouncement(id) {
    return this.data.announcements.find((announcement) => announcement.id === id);
  }

  removeAnnouncement(id) {
    this.data.announcements = this.data.announcements.filter((announcement) => announcement.id !== id);
  }
}
