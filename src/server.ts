import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { WorldStateStore } from "./store.js";
import { ENTITY_KINDS, type Change } from "./types.js";

const worldId = z.number().int().positive().describe("Numeric world ID from list_worlds or create_world.");
const entityKind = z.enum(ENTITY_KINDS);
const nullableId = z.number().int().positive().nullable();

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const entityFields = {
  kind: entityKind.optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional().describe("Durable free-text facts and characterization."),
  status: z.string().optional().describe("Current relevant state or activity."),
  role: z.string().optional(),
  locationId: nullableId.optional().describe("Current location for a character or item; null clears it."),
  locationRef: z.string().min(1).optional().describe("Batch-local ref of a newly created location."),
  parentId: nullableId.optional().describe("Parent location for a location; null clears it."),
  parentRef: z.string().min(1).optional().describe("Batch-local ref of a newly created parent location."),
  active: z.boolean().optional(),
  secret: z.boolean().optional().describe("GM-only information not returned unless explicitly requested.")
};

const changeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    ref: z.string().min(1).optional().describe("Unique local name usable by other changes in this batch."),
    kind: entityKind,
    name: z.string().min(1),
    description: z.string().optional(), status: z.string().optional(), role: z.string().optional(),
    locationId: nullableId.optional(), locationRef: z.string().min(1).optional(),
    parentId: nullableId.optional(), parentRef: z.string().min(1).optional(),
    active: z.boolean().optional(), secret: z.boolean().optional()
  }),
  z.object({ action: z.literal("update"), entityId: z.number().int().positive(), ...entityFields }),
  z.object({ action: z.literal("delete"), entityId: z.number().int().positive() })
]);

export function createServer(store: WorldStateStore): McpServer {
  const server = new McpServer({ name: "mcp-rpg-worldstate", version: "2.2.0" });

  server.registerTool("list_worlds", {
    title: "List RPG worlds",
    description: "List compact save-game entries. Use this first in a new chat; it never loads full world data.",
    annotations: { readOnlyHint: true }
  }, () => response(store.listWorlds()));

  server.registerTool("create_world", {
    title: "Create RPG world",
    description: "Create an isolated RPG world/campaign. Description holds its durable tone, setting, rules and boundaries as free text.",
    inputSchema: z.object({
      name: z.string().min(1),
      description: z.string().default(""),
      summary: z.string().default("").describe("Short save-preview premise, ideally a few sentences.")
    })
  }, ({ name, description, summary }) => response(store.createWorld(name, description, summary)));

  server.registerTool("update_world", {
    title: "Update durable world information",
    description: "Update a world's durable framing. Do not record transient narration here.",
    inputSchema: z.object({
      worldId, name: z.string().min(1).optional(), description: z.string().optional(), summary: z.string().optional()
    })
  }, ({ worldId: id, ...values }) => response(store.updateWorld(id, values)));

  server.registerTool("delete_world", {
    title: "Permanently delete RPG world",
    description: "Permanently delete a world and all related entities, scenes, checkpoints and events. Requires exact confirmation 'DELETE: <world name>'.",
    inputSchema: z.object({ worldId, confirmation: z.string() }),
    annotations: { destructiveHint: true }
  }, ({ worldId: id, confirmation }) => response(store.deleteWorld(id, confirmation)));

  server.registerTool("apply_world_changes", {
    title: "Apply relevant world-state changes",
    description: "Create, update or delete several durable entities atomically in one call. Create operations may define local refs used by locationRef or parentRef, including forward references. Store only lasting or story-relevant changes, preferably together at natural story boundaries.",
    inputSchema: z.object({
      worldId,
      changes: z.array(changeSchema).min(1).max(100),
      summary: z.string().optional().describe("Optional concise event summary explaining this group of changes."),
      eventSecret: z.boolean().default(false).describe("Mark the event summary as GM-only. Required when a summarized batch affects any secret entity.")
    })
  }, ({ worldId: id, changes, summary, eventSecret }) => response(store.applyChanges(id, changes as Change[], summary, eventSecret)));

  server.registerTool("search_entities", {
    title: "Search characters, locations, plots, notes and items",
    description: "Targeted lookup. Supports questions such as all characters in a world, where a character is, or which characters are at a location.",
    inputSchema: z.object({
      worldId, kind: entityKind.optional(), name: z.string().optional(), locationId: z.number().int().positive().optional(),
      query: z.string().optional(), active: z.boolean().optional(), includeSecrets: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50)
    }),
    annotations: { readOnlyHint: true }
  }, (args) => response(store.searchEntities(args)));

  server.registerTool("set_current_scene", {
    title: "Set current story scene",
    description: "Record the compact immediate scene in one operation. Participants describe who is narratively present; this does not move every character permanently.",
    inputSchema: z.object({
      worldId,
      title: z.string().min(1),
      summary: z.string().min(1),
      locationId: nullableId.optional(),
      participantIds: z.array(z.number().int().positive()).max(100).default([])
    })
  }, ({ worldId: id, ...input }) => response(store.setScene(id, input)));

  server.registerTool("get_world_overview", {
    title: "Load compact save preview",
    description: "Load a token-conscious save preview. The latest checkpoint contains only playerRecap by default; GM notes and other secret records require explicitly authorized secret access.",
    inputSchema: z.object({
      worldId,
      includeSecrets: z.boolean().default(false).describe("Return separately stored GM-only information. Use only in an authorized gamemaster context.")
    }),
    annotations: { readOnlyHint: true }
  }, ({ worldId: id, includeSecrets }) => response(store.getOverview(id, includeSecrets)));

  server.registerTool("get_current_context", {
    title: "Load current playable context",
    description: "Load world framing plus current scene, its location, characters currently assigned there and active plots. Use after the compact overview when continuing play.",
    inputSchema: z.object({ worldId, includeSecrets: z.boolean().default(true) }),
    annotations: { readOnlyHint: true }
  }, ({ worldId: id, includeSecrets }) => response(store.getCurrentContext(id, includeSecrets)));

  server.registerTool("create_checkpoint", {
    title: "Create save-game checkpoint",
    description: "Create a checkpoint with strictly separated player-safe recap and optional GM-only notes. The server does not classify or rewrite content; entities and events remain authoritative.",
    inputSchema: z.object({
      worldId,
      title: z.string().trim().min(1),
      playerRecap: z.string().trim().min(1).describe("Concise player-safe recap. Include only facts explicitly observed, learned, or reasonably known by the player characters. Never include concealed identities, motives, causes, plans, locations, future developments, or other unrevealed GM information."),
      gmNotes: z.string().trim().min(1).optional().describe("Optional GM-only checkpoint notes for concealed information relevant to continuing the campaign. Never returned unless secrets are explicitly requested.")
    }).strict()
  }, ({ worldId: id, title, playerRecap, gmNotes }) => response(store.createCheckpoint(id, title, playerRecap, gmNotes)));

  server.registerTool("get_recent_events", {
    title: "Read recent relevant events",
    description: "Read a compact newest-first history explaining how the authoritative current state developed. Supports backward pagination and events since a checkpoint; do not use it instead of current context.",
    inputSchema: z.object({
      worldId,
      limit: z.number().int().min(1).max(100).default(25),
      beforeId: z.number().int().positive().optional(),
      query: z.string().optional(),
      includeSecrets: z.boolean().default(false),
      sinceCheckpointId: z.number().int().positive().optional()
    }),
    annotations: { readOnlyHint: true }
  }, (args) => response(store.getRecentEvents(args)));

  server.registerTool("list_checkpoints", {
    title: "List earlier save checkpoints",
    description: "List player-safe checkpoint recaps newest first. GM notes remain absent unless includeSecrets is explicitly true in an authorized GM context.",
    inputSchema: z.object({
      worldId,
      limit: z.number().int().min(1).max(100).default(20),
      beforeId: z.number().int().positive().optional(),
      includeSecrets: z.boolean().default(false).describe("Return gmNotes as a separate field. Use only in an authorized gamemaster context.")
    }),
    annotations: { readOnlyHint: true }
  }, ({ worldId: id, limit, beforeId, includeSecrets }) => response(store.listCheckpoints(id, limit, beforeId, includeSecrets)));

  server.registerTool("random_numbers", {
    title: "Generate neutral random integers",
    description: "Generate random integers for unbiased narrative decisions. This is not a rules or dice system.",
    inputSchema: z.object({
      min: z.number().int(), max: z.number().int(), count: z.number().int().min(1).max(100).default(1)
    }),
    annotations: { readOnlyHint: true }
  }, ({ min, max, count }) => {
    if (min > max) throw new Error("min must be less than or equal to max.");
    if (!Number.isSafeInteger(max - min)) throw new Error("The requested range is too large.");
    return response({ min, max, values: Array.from({ length: count }, () => Math.floor(Math.random() * (max - min + 1)) + min) });
  });

  return server;
}
