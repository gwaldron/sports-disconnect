// Assignr sessions in a JSON file, for the local Node server.

import fs from 'node:fs/promises';
import path from 'node:path';

export class FileAssignrSessions {
  constructor(file, doneFile) {
    this.file = file;
    this.doneFile = doneFile;
  }

  async read(file = this.file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; }
  }

  async write(all, file = this.file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(all));
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

  async listDone(scope) {
    return Object.entries((await this.read(this.doneFile))[scope] || {}).map(([key, m]) => ({ key, ...m }));
  }

  async setDone(scope, key, mark) {
    const all = await this.read(this.doneFile);
    all[scope] ||= {};
    if (mark) all[scope][key] = mark; else delete all[scope][key];
    await this.write(all, this.doneFile);
  }
}
