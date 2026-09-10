import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { SCHEMA_VERSION, WorldStateStore } from "./store.js";

const stores: WorldStateStore[] = [];
const tempDirectories: string[] = [];
const makeStore = () => {
  const store = new WorldStateStore();
  stores.push(store);
  return store;
};

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirectories.length) {
    const directory = tempDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorldStateStore", () => {
  it("keeps worlds isolated and resolves current character locations", () => {
    const store = makeStore();
    const scifi = store.createWorld("Odyssey", "Realistic military science fiction");
    const fantasy = store.createWorld("Ashes", "Low fantasy");
    const bridge = store.createEntity(Number(scifi.id), { kind: "location", name: "Bridge" });
    const miller = store.createEntity(Number(scifi.id), {
      kind: "character", name: "Miller", status: "On watch", locationId: Number(bridge.id)
    });

    assert.equal(store.searchEntities({ worldId: Number(scifi.id), kind: "character" }).length, 1);
    assert.equal(store.searchEntities({ worldId: Number(fantasy.id), kind: "character" }).length, 0);
    assert.equal(store.searchEntities({
      worldId: Number(scifi.id), kind: "character", locationId: Number(bridge.id)
    })[0]?.id, miller.id);
    assert.throws(() => store.createEntity(Number(fantasy.id), {
      kind: "character", name: "Lost Miller", locationId: Number(bridge.id)
    }), /same world/);
  });

  it("models a scene without forcing temporary participant movement", () => {
    const store = makeStore();
    const world = store.createWorld("Odyssey", "Science fiction");
    const bridge = store.createEntity(Number(world.id), { kind: "location", name: "Bridge" });
    const mess = store.createEntity(Number(world.id), { kind: "location", name: "Mess Hall" });
    const miller = store.createEntity(Number(world.id), {
      kind: "character", name: "Miller", locationId: Number(bridge.id)
    });

    store.setScene(Number(world.id), {
      title: "Lunch briefing", summary: "Miller briefly joins the discussion.",
      locationId: Number(mess.id), participantIds: [Number(miller.id)]
    });
    const context = store.getCurrentContext(Number(world.id));

    assert.equal((context.currentScene as Record<string, unknown>).location_name, "Mess Hall");
    assert.equal(store.getEntity(Number(miller.id)).location_id, bridge.id);
  });

  it("applies a batch atomically and rolls it back on an invalid change", () => {
    const store = makeStore();
    const world = store.createWorld("Odyssey", "Science fiction");

    assert.throws(() => store.applyChanges(Number(world.id), [
      { action: "create", kind: "character", name: "Miller" },
      { action: "update", entityId: 9999, status: "Impossible" }
    ], "A failed event"), /does not exist/);

    assert.equal(store.searchEntities({ worldId: Number(world.id), kind: "character" }).length, 0);
    const events = store.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
    assert.equal(events.count, 0);
  });

  it("resolves forward local refs and returns their generated IDs", () => {
    const store = makeStore();
    const world = store.createWorld("Emberfall", "Fantasy");
    const result = store.applyChanges(Number(world.id), [
      { action: "create", ref: "mara", kind: "character", name: "Mara", locationRef: "tavern" },
      { action: "create", ref: "cellar", kind: "location", name: "Wine Cellar", parentRef: "tavern" },
      { action: "create", ref: "tavern", kind: "location", name: "The Limping Dragon" }
    ], "Mara and her tavern were introduced.");

    assert.ok(result.createdRefs.tavern);
    assert.equal(store.getEntity(Number(result.createdRefs.mara)).location_id, result.createdRefs.tavern);
    assert.equal(store.getEntity(Number(result.createdRefs.cellar)).parent_id, result.createdRefs.tavern);
  });

  it("rejects invalid, conflicting and circular local refs atomically", () => {
    const store = makeStore();
    const world = store.createWorld("Emberfall", "Fantasy");
    const id = Number(world.id);

    assert.throws(() => store.applyChanges(id, [
      { action: "create", ref: "mara", kind: "character", name: "Mara", locationRef: "missing" }
    ]), /Unknown local ref/);
    assert.throws(() => store.applyChanges(id, [
      { action: "create", ref: "a", kind: "location", name: "A", parentRef: "b" },
      { action: "create", ref: "b", kind: "location", name: "B", parentRef: "a" }
    ]), /circular dependency/);
    assert.throws(() => store.applyChanges(id, [
      { action: "create", ref: "inn", kind: "location", name: "Inn" },
      { action: "create", kind: "character", name: "Bernd", locationId: 99, locationRef: "inn" }
    ]), /cannot be used together/);
    assert.equal(store.searchEntities({ worldId: id, includeSecrets: true }).length, 0);
  });

  it("requires an explicitly secret event for batches affecting secret entities", () => {
    const store = makeStore();
    const world = store.createWorld("Emberfall", "Fantasy");
    const id = Number(world.id);
    assert.throws(() => store.applyChanges(id, [
      { action: "create", kind: "plot", name: "Mara's identity", secret: true }
    ], "Mara is secretly a dragon."), /eventSecret/);
    assert.equal(store.searchEntities({ worldId: id, includeSecrets: true }).length, 0);

    store.applyChanges(id, [
      { action: "create", kind: "plot", name: "Mara's identity", secret: true }
    ], "Mara is secretly a dragon.", true);
    assert.equal((store.getRecentEvents({ worldId: id }).events as unknown[]).length, 0);
    assert.equal((store.getRecentEvents({ worldId: id, includeSecrets: true }).events as unknown[]).length, 1);
  });

  it("paginates events and reads only events after a checkpoint cursor", () => {
    const store = makeStore();
    const world = store.createWorld("Emberfall", "Fantasy");
    const id = Number(world.id);
    store.applyChanges(id, [{ action: "create", kind: "note", name: "Arrival" }], "The group arrived.");
    const checkpoint = store.createCheckpoint(id, "Arrival", "The group reached town.");
    store.applyChanges(id, [{ action: "create", kind: "note", name: "Fire" }], "Bernd set the tavern on fire.");
    store.applyChanges(id, [{ action: "create", kind: "note", name: "Escape" }], "The group escaped.");

    const recent = store.getRecentEvents({ worldId: id, limit: 1 });
    assert.equal((recent.events as RowForTest[])[0]?.summary, "The group escaped.");
    assert.ok(recent.nextBeforeId);
    const since = store.getRecentEvents({ worldId: id, sinceCheckpointId: Number(checkpoint.id) });
    assert.deepEqual((since.events as RowForTest[]).map((event) => event.summary), [
      "The group escaped.", "Bernd set the tavern on fire."
    ]);
    const queried = store.getRecentEvents({ worldId: id, query: "tavern" });
    assert.equal((queried.events as unknown[]).length, 1);
  });

  it("lists checkpoint history newest first with backward pagination", () => {
    const store = makeStore();
    const world = store.createWorld("Emberfall", "Fantasy");
    const id = Number(world.id);
    store.createCheckpoint(id, "Chapter One", "Arrival");
    store.createCheckpoint(id, "Chapter Two", "Fire");
    const firstPage = store.listCheckpoints(id, 1);
    assert.equal((firstPage.checkpoints as RowForTest[])[0]?.title, "Chapter Two");
    const secondPage = store.listCheckpoints(id, 1, Number(firstPage.nextBeforeId));
    assert.equal((secondPage.checkpoints as RowForTest[])[0]?.title, "Chapter One");
  });

  it("keeps checkpoint GM notes out of every public checkpoint read", () => {
    const store = makeStore();
    const world = store.createWorld("Emberfall", "Fantasy");
    const id = Number(world.id);
    const publicOnly = store.createCheckpoint(id, "Arrival", "The group entered town.");
    assert.equal(publicOnly.playerRecap, "The group entered town.");
    assert.equal(publicOnly.gmNotes, undefined);
    store.createCheckpoint(id, "The Limping Dragon",
      "Bernd found a royal coin and Mara denied knowing it.", "Mara is the missing queen.");
    const publicOverview = store.getOverview(id);
    assert.equal((publicOverview.checkpoint as RowForTest).gmNotes, undefined);
    assert.doesNotMatch(JSON.stringify(publicOverview), /missing queen/);
    assert.equal((store.getOverview(id, true).checkpoint as RowForTest).gmNotes, "Mara is the missing queen.");
    const publicList = store.listCheckpoints(id);
    assert.ok((publicList.checkpoints as RowForTest[]).every((checkpoint) => !("gmNotes" in checkpoint)));
    const gmList = store.listCheckpoints(id, 20, undefined, true);
    assert.equal((gmList.checkpoints as RowForTest[])[0]?.gmNotes, "Mara is the missing queen.");
    assert.equal((publicList.checkpoints as RowForTest[])[0]?.eventCursorId,
      (gmList.checkpoints as RowForTest[])[0]?.eventCursorId);
  });

  it("migrates an unversioned v1 database without losing its world", () => {
    const directory = mkdtempSync(join(tmpdir(), "rpg-worldstate-migration-"));
    tempDirectories.push(directory);
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE worlds (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', current_scene_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE entities (id INTEGER PRIMARY KEY, world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('character','location','plot','note','item')), name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
        location_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, parent_id INTEGER REFERENCES entities(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL DEFAULT 1, secret INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(world_id, kind, name));
      CREATE TABLE scenes (id INTEGER PRIMARY KEY, world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', location_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE scene_participants (scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        character_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE, PRIMARY KEY(scene_id, character_id));
      CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        title TEXT NOT NULL, summary TEXT NOT NULL, scene_id INTEGER REFERENCES scenes(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE events (id INTEGER PRIMARY KEY, world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        summary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO worlds(name, description) VALUES ('Legacy', 'Preserve me');
      INSERT INTO checkpoints(world_id, title, summary) VALUES (1, 'Legacy secret', 'The innkeeper is secretly a dragon.');
    `);
    legacy.close();

    const migrated = new WorldStateStore(path);
    stores.push(migrated);
    assert.equal(migrated.listWorlds()[0]?.name, "Legacy");
    assert.equal((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.ok((migrated.db.prepare("PRAGMA table_info(events)").all() as RowForTest[]).some((column) => column.name === "secret"));
    assert.ok((migrated.db.prepare("PRAGMA table_info(checkpoints)").all() as RowForTest[]).some((column) => column.name === "event_cursor_id"));
    const publicHistory = migrated.listCheckpoints(1);
    assert.doesNotMatch(JSON.stringify(publicHistory), /secretly a dragon/);
    assert.match(String((publicHistory.checkpoints as RowForTest[])[0]?.playerRecap), /No reviewed player-safe recap/);
    const gmHistory = migrated.listCheckpoints(1, 20, undefined, true);
    assert.equal((gmHistory.checkpoints as RowForTest[])[0]?.gmNotes, "The innkeeper is secretly a dragon.");
    migrated.close();
    stores.pop();
    const reopened = new WorldStateStore(path);
    stores.push(reopened);
    assert.equal((reopened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal((reopened.listCheckpoints(1, 20, undefined, true).checkpoints as RowForTest[])[0]?.gmNotes,
      "The innkeeper is secretly a dragon.");
  });

  it("returns a compact overview with latest checkpoint and active plot", () => {
    const store = makeStore();
    const world = store.createWorld("Odyssey", "Long canonical description", "Short premise");
    store.createEntity(Number(world.id), {
      kind: "plot", name: "Unknown signal", status: "Awaiting a response"
    });
    store.createCheckpoint(Number(world.id), "Signal at Kepler-91", "The crew must decide whether to answer.");

    const overview = store.getOverview(Number(world.id));
    assert.equal((overview.world as Record<string, unknown>).summary, "Short premise");
    assert.equal((overview.checkpoint as Record<string, unknown>).title, "Signal at Kepler-91");
    assert.equal((overview.activePlots as unknown[]).length, 1);
    assert.equal((overview.world as Record<string, unknown>).description, undefined);
  });

  it("hides secret data unless requested", () => {
    const store = makeStore();
    const world = store.createWorld("Odyssey", "Science fiction");
    store.createEntity(Number(world.id), { kind: "plot", name: "Public signal" });
    store.createEntity(Number(world.id), { kind: "plot", name: "Hidden saboteur", secret: true });

    assert.equal(store.searchEntities({ worldId: Number(world.id), kind: "plot" }).length, 1);
    assert.equal(store.searchEntities({ worldId: Number(world.id), kind: "plot", includeSecrets: true }).length, 2);
  });

  it("requires exact confirmation and recursively deletes a world", () => {
    const store = makeStore();
    const world = store.createWorld("Odyssey", "Science fiction");
    const location = store.createEntity(Number(world.id), { kind: "location", name: "Bridge" });
    const room = store.createEntity(Number(world.id), { kind: "location", name: "Ready room", parentId: Number(location.id) });
    store.createEntity(Number(world.id), { kind: "location", name: "Closet", parentId: Number(room.id) });
    const character = store.createEntity(Number(world.id), { kind: "character", name: "Miller", locationId: Number(location.id) });
    store.setScene(Number(world.id), { title: "Watch", summary: "Quiet watch", participantIds: [Number(character.id)] });
    store.createCheckpoint(Number(world.id), "End of watch", "Nothing exploded.");

    assert.throws(() => store.deleteWorld(Number(world.id), "yes"), /Confirmation/);
    assert.equal(store.getEntity(Number(room.id)).parent_id, location.id);
    assert.throws(() => store.applyChanges(Number(world.id), [
      { action: "delete", entityId: Number(location.id) }
    ]), /FOREIGN KEY/);
    store.deleteWorld(Number(world.id), "DELETE: Odyssey");

    for (const table of ["entities", "scenes", "scene_participants", "checkpoints", "events"]) {
      const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      assert.equal(row.count, 0, `${table} should be empty`);
    }
  });

  it("preserves other worlds and rolls back hierarchy changes when world deletion fails", () => {
    const store = makeStore();
    const world = store.createWorld("Ankunft — Hanka & Thomas", "Test");
    const other = store.createWorld("Other", "Preserve me");
    const parent = store.createEntity(Number(world.id), { kind: "location", name: "House" });
    const child = store.createEntity(Number(world.id), { kind: "location", name: "Room", parentId: Number(parent.id) });
    const otherParent = store.createEntity(Number(other.id), { kind: "location", name: "House" });
    store.createEntity(Number(other.id), { kind: "location", name: "Room", parentId: Number(otherParent.id) });
    store.applyChanges(Number(world.id), [], "Arrival");
    const snapshot = () => ["worlds", "entities", "scenes", "scene_participants", "checkpoints", "events"]
      .map((table) => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    store.db.exec(`CREATE TRIGGER prevent_world_delete BEFORE DELETE ON worlds
      BEGIN SELECT RAISE(ABORT, 'Deletion blocked for test'); END`);
    assert.throws(() => store.deleteWorld(Number(world.id), `DELETE: ${world.name}`), /Deletion blocked/);
    assert.deepEqual(snapshot(), before);
    assert.equal(store.getEntity(Number(child.id)).parent_id, parent.id);
    store.db.exec("DROP TRIGGER prevent_world_delete");
    const otherBefore = store.searchEntities({ worldId: Number(other.id) });
    assert.deepEqual(store.deleteWorld(Number(world.id), `DELETE: ${world.name}`), {
      deleted: true, worldId: Number(world.id), name: world.name
    });
    assert.deepEqual(store.getWorld(Number(other.id)), before[0]?.[1]);
    assert.deepEqual(store.searchEntities({ worldId: Number(other.id) }), otherBefore);
    assert.throws(() => store.getWorld(Number(world.id)), /does not exist/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 0);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

type RowForTest = Record<string, unknown>;
