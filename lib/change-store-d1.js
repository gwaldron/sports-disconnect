// Change-tracking store backed by Cloudflare D1. Schema: migrations/0001_changes.sql.

const CHUNK = 200; // rows per statement; each chunk is passed as one JSON parameter

export class D1ChangeStore {
  constructor(db) { this.db = db; }

  async loadBaseline() {
    const [matches, meta] = await this.db.batch([
      this.db.prepare('SELECT match_id, data, first_seen, last_changed, removed_at, rev FROM matches'),
      this.db.prepare("SELECT value FROM meta WHERE key = 'tracking_since'"),
    ]);
    const rows = new Map();
    for (const r of matches.results) {
      rows.set(r.match_id, {
        matchId: r.match_id, data: JSON.parse(r.data), firstSeen: r.first_seen,
        lastChanged: r.last_changed, removedAt: r.removed_at, rev: r.rev,
      });
    }
    return { rows, trackingSince: meta.results[0]?.value || null };
  }

  async save({ upserts, changes, trackingSince }) {
    const stmts = [
      this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('tracking_since', ?1)").bind(trackingSince),
    ];
    // json_each lets one statement upsert a whole chunk.
    for (let i = 0; i < upserts.length; i += CHUNK) {
      stmts.push(this.db.prepare(`
        INSERT INTO matches (match_id, data, first_seen, last_changed, removed_at, rev)
        SELECT json_extract(value, '$.matchId'), json_extract(value, '$.data'), json_extract(value, '$.firstSeen'),
               json_extract(value, '$.lastChanged'), json_extract(value, '$.removedAt'), json_extract(value, '$.rev')
        FROM json_each(?1) WHERE true
        ON CONFLICT (match_id) DO UPDATE SET data = excluded.data, first_seen = excluded.first_seen,
          last_changed = excluded.last_changed, removed_at = excluded.removed_at, rev = excluded.rev`)
        .bind(JSON.stringify(upserts.slice(i, i + CHUNK))));
    }
    for (let i = 0; i < changes.length; i += CHUNK) {
      stmts.push(this.db.prepare(`
        INSERT OR IGNORE INTO changes (id, at, match_id, kind, field, old, new)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.at'), json_extract(value, '$.matchId'),
               json_extract(value, '$.kind'), json_extract(value, '$.field'), json_extract(value, '$.from'), json_extract(value, '$.to')
        FROM json_each(?1)`)
        .bind(JSON.stringify(changes.slice(i, i + CHUNK))));
    }
    await this.db.batch(stmts);
  }

  async recentChanges(sinceIso) {
    const { results } = await this.db
      .prepare('SELECT id, at, match_id, kind, field, old, new FROM changes WHERE at >= ?1 ORDER BY at DESC, id LIMIT 2000')
      .bind(sinceIso).all();
    return results.map((r) => ({ id: r.id, at: r.at, matchId: r.match_id, kind: r.kind, field: r.field, from: r.old, to: r.new }));
  }
}
