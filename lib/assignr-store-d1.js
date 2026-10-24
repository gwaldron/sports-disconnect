// Assignr sessions in Cloudflare D1. Schema: migrations/0003_assignr_sessions.sql.

const STALE_DAYS = 90;

export class D1AssignrSessions {
  constructor(db) { this.db = db; }

  async get(idHash) {
    const r = await this.db.prepare('SELECT * FROM assignr_sessions WHERE id_hash = ?1').bind(idHash).first();
    return r && {
      idHash: r.id_hash, created: r.created, lastUsed: r.last_used,
      accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at,
      accountName: r.account_name, games: r.games_json ? JSON.parse(r.games_json) : null,
      gamesFetchedAt: r.games_fetched_at || 0,
    };
  }

  async put(s) {
    const cutoff = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
    await this.db.batch([
      this.db.prepare(`INSERT OR REPLACE INTO assignr_sessions
        (id_hash, created, last_used, access_token, refresh_token, expires_at, account_name, games_json, games_fetched_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
        .bind(s.idHash, s.created, s.lastUsed, s.accessToken, s.refreshToken, s.expiresAt,
          s.accountName, s.games ? JSON.stringify(s.games) : null, s.gamesFetchedAt || 0),
      // Housekeeping: forget sessions nobody has used in a while.
      this.db.prepare('DELETE FROM assignr_sessions WHERE last_used < ?1').bind(cutoff),
    ]);
  }

  async delete(idHash) {
    await this.db.prepare('DELETE FROM assignr_sessions WHERE id_hash = ?1').bind(idHash).run();
  }
}
