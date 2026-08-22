import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { WorldStateStore } from "./store.js";

it("exposes and executes the MCP tools through the protocol", async () => {
  const store = new WorldStateStore();
  const server = createServer(store);
  const client = new Client({ name: "worldstate-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "apply_world_changes", "create_checkpoint", "create_world", "delete_world",
      "get_current_context", "get_recent_events", "get_world_overview", "list_checkpoints", "list_worlds", "random_numbers",
      "search_entities", "set_current_scene", "update_world"
    ]);

    const result = await client.callTool({ name: "random_numbers", arguments: { min: 7, max: 7, count: 3 } });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /7/);

    const createdWorld = await client.callTool({
      name: "create_world", arguments: { name: "Protocol World", description: "Test" }
    });
    const world = parseTextResult(createdWorld.content);
    const batch = await client.callTool({
      name: "apply_world_changes",
      arguments: {
        worldId: world.id,
        changes: [
          { action: "create", ref: "miller", kind: "character", name: "Miller", locationRef: "bridge" },
          { action: "create", ref: "bridge", kind: "location", name: "Bridge" }
        ],
        summary: "Miller took the bridge watch."
      }
    });
    const batchResult = parseTextResult(batch.content);
    assert.ok((batchResult.createdRefs as Record<string, number>).bridge);
    const events = await client.callTool({ name: "get_recent_events", arguments: { worldId: world.id } });
    assert.match(JSON.stringify(events.content), /bridge watch/);

    const invalidCheckpoint = await client.callTool({
      name: "create_checkpoint",
      arguments: { worldId: world.id, title: "Legacy input", summary: "Potential secret" }
    });
    assert.equal(invalidCheckpoint.isError, true);
    const checkpoint = await client.callTool({
      name: "create_checkpoint",
      arguments: {
        worldId: world.id, title: "End of watch",
        playerRecap: "Miller completed an uneventful watch.",
        gmNotes: "Miller did not notice the hidden transmitter."
      }
    });
    assert.equal(checkpoint.isError, undefined);
    const publicCheckpoints = await client.callTool({
      name: "list_checkpoints", arguments: { worldId: world.id }
    });
    assert.doesNotMatch(JSON.stringify(publicCheckpoints.content), /hidden transmitter/);
    const gmCheckpoints = await client.callTool({
      name: "list_checkpoints", arguments: { worldId: world.id, includeSecrets: true }
    });
    assert.match(JSON.stringify(gmCheckpoints.content), /hidden transmitter/);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

function parseTextResult(content: unknown): Record<string, unknown> {
  const blocks = content as Array<{ type: string; text?: string }>;
  const text = blocks.find((block) => block.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text) as Record<string, unknown>;
}
