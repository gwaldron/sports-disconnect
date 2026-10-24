// Assignr sessions in a JSON file, for the local Node server.

import fs from 'node:fs/promises';
import path from 'node:path';

export class FileAssignrSessions {
  constructor(file) { this.file = file; }

  async read() {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return {}; }
  }

  async write(all) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(all));
  }

  async get(idHash) { return (await this.read())[idHash] || null; }

  async put(s) {
    const all = await this.read();
    all[s.idHash] = s;
    await this.write(all);
  }

  async delete(idHash) {
    const all = await this.read();
    delete all[idHash];
    await this.write(all);
  }
}
