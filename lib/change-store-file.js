// Change-tracking store backed by a JSON file, for the local Node server.

import fs from 'node:fs/promises';
import path from 'node:path';

export class FileChangeStore {
  constructor(file) { this.file = file; }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      return { trackingSince: null, matches: {}, changes: [] };
    }
  }

  async loadBaseline() {
    const db = await this.read();
    return { rows: new Map(Object.values(db.matches).map((r) => [r.matchId, r])), trackingSince: db.trackingSince };
  }

  async save({ upserts, changes, trackingSince }) {
    const db = await this.read();
    db.trackingSince ||= trackingSince;
    for (const row of upserts) db.matches[row.matchId] = row;
    const ids = new Set(db.changes.map((c) => c.id));
    db.changes.push(...changes.filter((c) => !ids.has(c.id)));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(db));
  }

  async recentChanges(sinceIso) {
    const db = await this.read();
    return db.changes.filter((c) => c.at >= sinceIso)
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  }
}
