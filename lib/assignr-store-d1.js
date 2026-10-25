// Assignr sessions and shared "Mark done" entries in Cloudflare D1. Schema: migrations/0003, 0004.

const STALE_DAYS = 90;
const DONE_DAYS = 60; // older "Mark done" entries are for changes long out of view

export class D1AssignrSessions {
  constructor(db) { this.db = db; }

  async get(idHash) {
    const r = await this.db.prepare('SELECT * FROM assignr_sessions WHERE id_hash = ?1').bind(idHash).first();
    return r && {
      idHash: r.id_hash, created: r.created, lastUsed: r.last_used,
      accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at,
      accountName: r.account_name, accountId: r.account_id, scope: r.scope,
      games: r.games_json ? JSON.parse(r.games_json) : null,
      gamesFetchedAt: r.games_fetched_at || 0,
    };
  }

  async put(s) {
    const cutoff = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
    await this.db.batch([
      this.db.prepare(`INSERT OR REPLACE INTO assignr_sessions
        (id_hash, created, last_used, access_token, refresh_token, expires_at, account_name, account_id, scope, games_json, games_fetched_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
        .bind(s.idHash, s.created, s.lastUsed, s.accessToken, s.refreshToken, s.expiresAt, s.accountName,
          s.accountId == null ? null : String(s.accountId), s.scope ?? null,
          s.games ? JSON.stringify(s.games) : null, s.gamesFetchedAt || 0),
      // Housekeeping: forget sessions nobody has used in a while.
      this.db.prepare('DELETE FROM assignr_sessions WHERE last_used < ?1').bind(cutoff),
    ]);
  }

  async delete(idHash) {
    await this.db.prepare('DELETE FROM assignr_sessions WHERE id_hash = ?1').bind(idHash).run();
  }

  async listDone(scope) {
    const { results } = await this.db
      .prepare('SELECT change_key, done_at, done_by FROM assignr_done WHERE scope = ?1').bind(scope).all();
    return results.map((r) => ({ key: r.change_key, at: r.done_at, by: r.done_by }));
  }

  async setDone(scope, key, mark) {
    const cutoff = new Date(Date.now() - DONE_DAYS * 86400_000).toISOString();
    await this.db.batch([
      mark
        ? this.db.prepare('INSERT OR REPLACE INTO assignr_done (scope, change_key, done_at, done_by) VALUES (?1, ?2, ?3, ?4)')
          .bind(scope, key, mark.at, mark.by ?? null)
        : this.db.prepare('DELETE FROM assignr_done WHERE scope = ?1 AND change_key = ?2').bind(scope, key),
      this.db.prepare('DELETE FROM assignr_done WHERE done_at < ?1').bind(cutoff),
    ]);
  }
}
