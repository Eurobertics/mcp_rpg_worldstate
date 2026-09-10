import { DatabaseSync } from "node:sqlite";
import type { ApplyChangesResult, Change, EntityInput, EntityKind } from "./types.js";

type Row = Record<string, unknown>;

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const SCHEMA_VERSION = 3;
const LEGACY_CHECKPOINT_RECAP = "No reviewed player-safe recap is available for this older checkpoint.";

export class WorldStateStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > SCHEMA_VERSION) {
      throw new Error(`Database schema version ${version.user_version} is newer than supported version ${SCHEMA_VERSION}.`);
    }

    if (version.user_version < 1) this.migrateToV1();
    if (version.user_version < 2) this.migrateToV2();
    if (version.user_version < 3) this.migrateToV3();
  }

  private migrateToV1(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS worlds (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        current_scene_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (${nowSql}),
        updated_at TEXT NOT NULL DEFAULT (${nowSql})
      );

      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY,
        world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('character','location','plot','note','item')),
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        location_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
        parent_id INTEGER REFERENCES entities(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        secret INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (${nowSql}),
        updated_at TEXT NOT NULL DEFAULT (${nowSql}),
        UNIQUE(world_id, kind, name)
      );

      CREATE TABLE IF NOT EXISTS scenes (
        id INTEGER PRIMARY KEY,
        world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        location_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (${nowSql}),
        updated_at TEXT NOT NULL DEFAULT (${nowSql})
      );

      CREATE TABLE IF NOT EXISTS scene_participants (
        scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        character_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        PRIMARY KEY(scene_id, character_id)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY,
        world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        scene_id INTEGER REFERENCES scenes(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (${nowSql})
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${nowSql})
      );

      CREATE INDEX IF NOT EXISTS idx_entities_world_kind ON entities(world_id, kind);
      CREATE INDEX IF NOT EXISTS idx_entities_location ON entities(world_id, location_id);
      CREATE INDEX IF NOT EXISTS idx_entities_active ON entities(world_id, active);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_world ON checkpoints(world_id, id DESC);
      PRAGMA user_version = 1;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateToV2(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasColumn("events", "secret")) {
        this.db.exec("ALTER TABLE events ADD COLUMN secret INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0,1))");
      }
      if (!this.hasColumn("checkpoints", "event_cursor_id")) {
        this.db.exec("ALTER TABLE checkpoints ADD COLUMN event_cursor_id INTEGER");
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_world_id ON events(world_id, id DESC);
        PRAGMA user_version = 2;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateToV3(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasColumn("checkpoints", "player_recap")) {
        this.db.exec(`ALTER TABLE checkpoints ADD COLUMN player_recap TEXT NOT NULL DEFAULT '${LEGACY_CHECKPOINT_RECAP.replaceAll("'", "''")}'`);
      }
      if (!this.hasColumn("checkpoints", "gm_notes")) {
        this.db.exec("ALTER TABLE checkpoints ADD COLUMN gm_notes TEXT");
      }
      this.db.exec(`
        UPDATE checkpoints
        SET gm_notes = CASE WHEN summary <> '' THEN summary ELSE NULL END,
            player_recap = '${LEGACY_CHECKPOINT_RECAP.replaceAll("'", "''")}'
        WHERE gm_notes IS NULL;
        PRAGMA user_version = 3;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((row) => row.name === column);
  }

  createWorld(name: string, description: string, summary = ""): Row {
    const result = this.db.prepare(
      `INSERT INTO worlds(name, description, summary) VALUES (?, ?, ?)`
    ).run(name, description, summary);
    return this.getWorld(Number(result.lastInsertRowid));
  }

  getWorld(worldId: number): Row {
    const world = this.db.prepare(`SELECT * FROM worlds WHERE id = ?`).get(worldId) as Row | undefined;
    if (!world) throw new Error(`World ${worldId} does not exist.`);
    return world;
  }

  listWorlds(): Row[] {
    return this.db.prepare(`
      SELECT w.id, w.name, w.summary, w.updated_at,
        (SELECT COUNT(*) FROM entities e WHERE e.world_id = w.id) AS entity_count,
        (SELECT COUNT(*) FROM checkpoints c WHERE c.world_id = w.id) AS checkpoint_count
      FROM worlds w ORDER BY w.updated_at DESC
    `).all() as Row[];
  }

  updateWorld(worldId: number, values: { name?: string; description?: string; summary?: string }): Row {
    this.getWorld(worldId);
    const entries = Object.entries(values).filter(([, value]) => value !== undefined);
    if (entries.length) {
      const columns = entries.map(([key]) => `${key} = ?`).join(", ");
      this.db.prepare(`UPDATE worlds SET ${columns}, updated_at = ${nowSql} WHERE id = ?`)
        .run(...entries.map(([, value]) => value), worldId);
    }
    return this.getWorld(worldId);
  }

  deleteWorld(worldId: number, confirmation: string): { deleted: true; worldId: number; name: string } {
    const world = this.getWorld(worldId);
    const expected = `DELETE: ${String(world.name)}`;
    if (confirmation !== expected) throw new Error(`Confirmation must exactly equal ${JSON.stringify(expected)}.`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Parent RESTRICT links otherwise block the world's cascading entity deletion.
      this.db.prepare(`UPDATE entities SET parent_id = NULL WHERE world_id = ? AND parent_id IS NOT NULL`).run(worldId);
      this.db.prepare(`DELETE FROM worlds WHERE id = ?`).run(worldId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { deleted: true, worldId, name: String(world.name) };
  }

  private validateEntityLinks(worldId: number, input: Partial<EntityInput>, entityId?: number): void {
    if (input.locationId != null) {
      const location = this.getEntity(input.locationId);
      if (location.world_id !== worldId || location.kind !== "location") {
        throw new Error("locationId must reference a location in the same world.");
      }
    }
    if (input.parentId != null) {
      let parent = this.getEntity(input.parentId);
      if (parent.world_id !== worldId || parent.kind !== "location") {
        throw new Error("parentId must reference a location in the same world.");
      }
      const visited = new Set<number>();
      while (parent) {
        const parentEntityId = Number(parent.id);
        if (parentEntityId === entityId) throw new Error("Location parents cannot form a cycle.");
        if (visited.has(parentEntityId)) throw new Error("Existing location hierarchy contains a cycle.");
        visited.add(parentEntityId);
        if (parent.parent_id == null) break;
        parent = this.getEntity(Number(parent.parent_id));
      }
    }
  }

  createEntity(worldId: number, input: EntityInput): Row {
    this.getWorld(worldId);
    this.validateEntityLinks(worldId, input);
    if (input.parentId != null && input.kind !== "location") {
      throw new Error("Only locations can have a parentId. Use locationId for other entities.");
    }
    const result = this.db.prepare(`
      INSERT INTO entities(world_id, kind, name, description, status, role, location_id, parent_id, active, secret)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(worldId, input.kind, input.name, input.description ?? "", input.status ?? "", input.role ?? "",
      input.locationId ?? null, input.parentId ?? null, input.active === false ? 0 : 1, input.secret ? 1 : 0);
    this.touchWorld(worldId);
    return this.getEntity(Number(result.lastInsertRowid));
  }

  getEntity(entityId: number): Row {
    const entity = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(entityId) as Row | undefined;
    if (!entity) throw new Error(`Entity ${entityId} does not exist.`);
    return entity;
  }

  updateEntity(worldId: number, entityId: number, input: Partial<EntityInput>): Row {
    const current = this.getEntity(entityId);
    if (current.world_id !== worldId) throw new Error(`Entity ${entityId} does not belong to world ${worldId}.`);
    this.validateEntityLinks(worldId, input, entityId);
    const resultingKind = input.kind ?? current.kind;
    const resultingParent = input.parentId === undefined ? current.parent_id : input.parentId;
    if (resultingParent != null && resultingKind !== "location") {
      throw new Error("Only locations can have a parentId. Use locationId for other entities.");
    }
    const allowed: Record<string, string> = {
      kind: "kind", name: "name", description: "description", status: "status", role: "role",
      locationId: "location_id", parentId: "parent_id", active: "active", secret: "secret"
    };
    const entries = Object.entries(input).filter(([, value]) => value !== undefined);
    if (entries.length) {
      const columns = entries.map(([key]) => `${allowed[key]} = ?`).join(", ");
      const values = entries.map(([key, value]) => {
        if (key === "active" || key === "secret") return value ? 1 : 0;
        return value as string | number | null;
      });
      this.db.prepare(`UPDATE entities SET ${columns}, updated_at = ${nowSql} WHERE id = ?`).run(...values, entityId);
      this.touchWorld(worldId);
    }
    return this.getEntity(entityId);
  }

  applyChanges(worldId: number, changes: Change[], summary?: string, eventSecret = false): ApplyChangesResult {
    this.getWorld(worldId);
    const refs = new Map<string, number>();
    for (const change of changes) {
      if (change.action !== "create" || change.ref === undefined) continue;
      if (refs.has(change.ref)) throw new Error(`Duplicate local ref ${JSON.stringify(change.ref)}.`);
      refs.set(change.ref, 0);
    }
    for (const change of changes) {
      if (change.action === "delete") continue;
      if (change.locationId !== undefined && change.locationRef !== undefined) {
        throw new Error("locationId and locationRef cannot be used together.");
      }
      if (change.parentId !== undefined && change.parentRef !== undefined) {
        throw new Error("parentId and parentRef cannot be used together.");
      }
      for (const ref of [change.locationRef, change.parentRef]) {
        if (ref !== undefined && !refs.has(ref)) throw new Error(`Unknown local ref ${JSON.stringify(ref)}.`);
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results: Row[] = Array.from({ length: changes.length });
      const pendingCreates = changes
        .map((change, index) => ({ change, index }))
        .filter((entry): entry is { change: Extract<Change, { action: "create" }>; index: number } => entry.change.action === "create");
      let affectedSecret = false;

      while (pendingCreates.length) {
        const readyIndex = pendingCreates.findIndex(({ change }) =>
          [change.locationRef, change.parentRef].every((ref) => ref === undefined || (refs.get(ref) ?? 0) > 0));
        if (readyIndex < 0) throw new Error("Local refs contain a circular dependency.");
        const ready = pendingCreates.splice(readyIndex, 1)[0];
        if (!ready) throw new Error("Internal error while resolving local refs.");
        const { change, index } = ready;
        const { action: _, ref, locationRef, parentRef, ...input } = change;
        const resolved: EntityInput = {
          ...input,
          locationId: locationRef === undefined ? input.locationId : refs.get(locationRef),
          parentId: parentRef === undefined ? input.parentId : refs.get(parentRef)
        };
        const created = this.createEntity(worldId, resolved);
        results[index] = created;
        affectedSecret ||= Boolean(created.secret);
        if (ref !== undefined) refs.set(ref, Number(created.id));
      }

      changes.forEach((change, index) => {
        if (change.action === "create") return;
        if (change.action === "update") {
          const current = this.getEntity(change.entityId);
          const { action: _, entityId, locationRef, parentRef, ...input } = change;
          const resolved: Partial<EntityInput> = {
            ...input,
            locationId: locationRef === undefined ? input.locationId : refs.get(locationRef),
            parentId: parentRef === undefined ? input.parentId : refs.get(parentRef)
          };
          const updated = this.updateEntity(worldId, entityId, resolved);
          results[index] = updated;
          affectedSecret ||= Boolean(current.secret) || Boolean(updated.secret);
          return;
        }
        const entity = this.getEntity(change.entityId);
        if (entity.world_id !== worldId) throw new Error(`Entity ${change.entityId} does not belong to world ${worldId}.`);
        this.db.prepare(`DELETE FROM entities WHERE id = ?`).run(change.entityId);
        results[index] = { deleted: true, entityId: change.entityId };
        affectedSecret ||= Boolean(entity.secret);
      });
      if (summary && affectedSecret && !eventSecret) {
        throw new Error("The batch affects secret entities; its event summary must set eventSecret to true or be omitted.");
      }
      if (summary) this.db.prepare(`INSERT INTO events(world_id, summary, secret) VALUES (?, ?, ?)`)
        .run(worldId, summary, eventSecret ? 1 : 0);
      this.touchWorld(worldId);
      this.db.exec("COMMIT");
      return { results, createdRefs: Object.fromEntries([...refs].filter(([, id]) => id > 0)) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  searchEntities(filters: {
    worldId: number; kind?: EntityKind; name?: string; locationId?: number;
    query?: string; active?: boolean; includeSecrets?: boolean; limit?: number;
  }): Row[] {
    this.getWorld(filters.worldId);
    const where = ["e.world_id = ?"];
    const values: Array<string | number | null> = [filters.worldId];
    if (filters.kind) { where.push("e.kind = ?"); values.push(filters.kind); }
    if (filters.name) { where.push("e.name LIKE ? COLLATE NOCASE"); values.push(`%${filters.name}%`); }
    if (filters.locationId !== undefined) { where.push("e.location_id = ?"); values.push(filters.locationId); }
    if (filters.active !== undefined) { where.push("e.active = ?"); values.push(filters.active ? 1 : 0); }
    if (!filters.includeSecrets) where.push("e.secret = 0");
    if (filters.query) {
      where.push("(e.name LIKE ? OR e.description LIKE ? OR e.status LIKE ? OR e.role LIKE ?)");
      const term = `%${filters.query}%`; values.push(term, term, term, term);
    }
    values.push(Math.min(filters.limit ?? 50, 200));
    return this.db.prepare(`
      SELECT e.*, l.name AS location_name, p.name AS parent_name
      FROM entities e
      LEFT JOIN entities l ON l.id = e.location_id
      LEFT JOIN entities p ON p.id = e.parent_id
      WHERE ${where.join(" AND ")}
      ORDER BY e.kind, e.name LIMIT ?
    `).all(...values) as Row[];
  }

  setScene(worldId: number, input: {
    title: string; summary: string; locationId?: number | null; participantIds?: number[];
  }): Row {
    this.getWorld(worldId);
    this.validateEntityLinks(worldId, { locationId: input.locationId });
    for (const id of input.participantIds ?? []) {
      const entity = this.getEntity(id);
      if (entity.world_id !== worldId || entity.kind !== "character") {
        throw new Error(`Participant ${id} must be a character in world ${worldId}.`);
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`INSERT INTO scenes(world_id, title, summary, location_id) VALUES (?, ?, ?, ?)`)
        .run(worldId, input.title, input.summary, input.locationId ?? null);
      const sceneId = Number(result.lastInsertRowid);
      const add = this.db.prepare(`INSERT INTO scene_participants(scene_id, character_id) VALUES (?, ?)`);
      for (const id of input.participantIds ?? []) add.run(sceneId, id);
      this.db.prepare(`UPDATE worlds SET current_scene_id = ?, updated_at = ${nowSql} WHERE id = ?`).run(sceneId, worldId);
      this.db.exec("COMMIT");
      return this.getScene(sceneId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getScene(sceneId: number, includeSecrets = true): Row {
    const scene = this.db.prepare(`
      SELECT s.*, l.name AS location_name FROM scenes s
      LEFT JOIN entities l ON l.id = s.location_id WHERE s.id = ?
    `).get(sceneId) as Row | undefined;
    if (!scene) throw new Error(`Scene ${sceneId} does not exist.`);
    scene.participants = this.db.prepare(`
      SELECT e.id, e.name, e.role, e.status FROM scene_participants sp
      JOIN entities e ON e.id = sp.character_id
      WHERE sp.scene_id = ? AND (? = 1 OR e.secret = 0) ORDER BY e.name
    `).all(sceneId, includeSecrets ? 1 : 0);
    return scene;
  }

  createCheckpoint(worldId: number, title: string, playerRecap: string, gmNotes?: string): Row {
    const world = this.getWorld(worldId);
    const latestEvent = this.db.prepare(`SELECT MAX(id) AS id FROM events WHERE world_id = ?`).get(worldId) as { id: number | null };
    const result = this.db.prepare(`
      INSERT INTO checkpoints(world_id, title, summary, player_recap, gm_notes, scene_id, event_cursor_id)
      VALUES (?, ?, '', ?, ?, ?, ?)
    `).run(worldId, title, playerRecap, gmNotes ?? null,
      world.current_scene_id == null ? null : Number(world.current_scene_id), latestEvent.id);
    this.touchWorld(worldId);
    return this.getCheckpoint(Number(result.lastInsertRowid), true);
  }

  private getCheckpoint(checkpointId: number, includeSecrets: boolean): Row {
    const secretColumn = includeSecrets ? ", gm_notes AS gmNotes" : "";
    const checkpoint = this.db.prepare(`
      SELECT id, world_id AS worldId, title, player_recap AS playerRecap,
        scene_id AS sceneId, event_cursor_id AS eventCursorId, created_at AS createdAt${secretColumn}
      FROM checkpoints WHERE id = ?
    `).get(checkpointId) as Row | undefined;
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} does not exist.`);
    if (checkpoint.gmNotes == null) delete checkpoint.gmNotes;
    return checkpoint;
  }

  getRecentEvents(filters: {
    worldId: number; limit?: number; beforeId?: number; query?: string;
    includeSecrets?: boolean; sinceCheckpointId?: number;
  }): Row {
    this.getWorld(filters.worldId);
    const where = ["world_id = ?"];
    const values: Array<string | number> = [filters.worldId];
    if (!filters.includeSecrets) where.push("secret = 0");
    if (filters.beforeId !== undefined) { where.push("id < ?"); values.push(filters.beforeId); }
    if (filters.query) { where.push("summary LIKE ?"); values.push(`%${filters.query}%`); }
    if (filters.sinceCheckpointId !== undefined) {
      const checkpoint = this.db.prepare(`SELECT world_id, event_cursor_id FROM checkpoints WHERE id = ?`)
        .get(filters.sinceCheckpointId) as Row | undefined;
      if (!checkpoint || checkpoint.world_id !== filters.worldId) {
        throw new Error(`Checkpoint ${filters.sinceCheckpointId} does not belong to world ${filters.worldId}.`);
      }
      where.push("id > ?");
      values.push(checkpoint.event_cursor_id == null ? 0 : Number(checkpoint.event_cursor_id));
    }
    const limit = Math.min(filters.limit ?? 25, 100);
    const events = this.db.prepare(`
      SELECT id, world_id, summary, secret, created_at FROM events
      WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?
    `).all(...values, limit) as Row[];
    return { order: "newest_first", events, nextBeforeId: events.length === limit ? events.at(-1)?.id ?? null : null };
  }

  listCheckpoints(worldId: number, limit = 20, beforeId?: number, includeSecrets = false): Row {
    this.getWorld(worldId);
    const where = ["world_id = ?"];
    const values: number[] = [worldId];
    if (beforeId !== undefined) { where.push("id < ?"); values.push(beforeId); }
    const boundedLimit = Math.min(limit, 100);
    const secretColumn = includeSecrets ? ", gm_notes AS gmNotes" : "";
    const checkpoints = this.db.prepare(`
      SELECT id, world_id AS worldId, title, player_recap AS playerRecap,
        scene_id AS sceneId, event_cursor_id AS eventCursorId, created_at AS createdAt${secretColumn}
      FROM checkpoints WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?
    `).all(...values, boundedLimit) as Row[];
    for (const checkpoint of checkpoints) {
      if (checkpoint.gmNotes == null) delete checkpoint.gmNotes;
    }
    return {
      order: "newest_first", checkpoints,
      nextBeforeId: checkpoints.length === boundedLimit ? checkpoints.at(-1)?.id ?? null : null
    };
  }

  getOverview(worldId: number, includeSecrets = false): Row {
    const world = this.getWorld(worldId);
    const latestCheckpoint = this.db.prepare(`SELECT id FROM checkpoints WHERE world_id = ? ORDER BY id DESC LIMIT 1`)
      .get(worldId) as { id: number } | undefined;
    const checkpoint = latestCheckpoint ? this.getCheckpoint(latestCheckpoint.id, includeSecrets) : null;
    const counts = this.db.prepare(`SELECT kind, COUNT(*) AS count FROM entities WHERE world_id = ? GROUP BY kind`).all(worldId);
    const activePlots = this.searchEntities({ worldId, kind: "plot", active: true, includeSecrets, limit: 10 })
      .map(({ id, name, status }) => ({ id, name, status }));
    const currentScene = world.current_scene_id ? this.getScene(Number(world.current_scene_id), includeSecrets) : null;
    return { world: { id: world.id, name: world.name, summary: world.summary, updated_at: world.updated_at }, checkpoint, currentScene, activePlots, counts };
  }

  getCurrentContext(worldId: number, includeSecrets = false): Row {
    const world = this.getWorld(worldId);
    const currentScene = world.current_scene_id ? this.getScene(Number(world.current_scene_id), includeSecrets) : null;
    const locationId = currentScene?.location_id == null ? undefined : Number(currentScene.location_id);
    const location = locationId === undefined ? null : this.getEntity(locationId);
    const charactersAtLocation = locationId === undefined ? [] : this.searchEntities({
      worldId, kind: "character", locationId, active: true, includeSecrets, limit: 100
    });
    const activePlots = this.searchEntities({ worldId, kind: "plot", active: true, includeSecrets, limit: 25 });
    return {
      world: { id: world.id, name: world.name, description: world.description, summary: world.summary },
      currentScene, location, charactersAtLocation, activePlots
    };
  }

  private touchWorld(worldId: number): void {
    this.db.prepare(`UPDATE worlds SET updated_at = ${nowSql} WHERE id = ?`).run(worldId);
  }
}
