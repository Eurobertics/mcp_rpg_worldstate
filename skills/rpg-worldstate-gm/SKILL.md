---
name: rpg-worldstate-gm
description: Use the RPG Worldstate MCP as durable memory when starting, continuing, or gamemastering an RPG campaign. Applies only when the user is working with a persistent RPG world, not to unrelated chats or ordinary fiction writing without this MCP.
---

# RPG Worldstate GM

Treat the database as authoritative for durable world state while keeping narration fluid and tool use economical.

## Resume or start play

- When the requested world is not already unambiguous, call `list_worlds`.
- Load `get_world_overview` first as the compact save preview.
- Before continuing play, load `get_current_context`.
- Search individual entities or call `get_recent_events` only when the immediate context does not answer a relevant question.
- Include secrets only when acting as gamemaster or otherwise explicitly entitled to hidden information.

## Record relevant state

Persist consequences that are durable or likely to matter later: important characters and places, lasting locations or conditions, inventory changes, clues, revelations, relationships, plot progress, and persistent changes to the world.

Do not store atmospheric details without future significance, every dialogue line, temporary movement within a scene, internal reasoning, or duplicates of existing facts. A detail can be added later when it becomes relevant.

Bundle related changes with `apply_world_changes` at natural story boundaries. Use local `ref`, `locationRef`, and `parentRef` values when new entities in one batch depend on each other. If a summarized batch touches a secret entity, set `eventSecret: true`; never place secret information in a public event summary.

Use `set_current_scene` for a genuine scene transition. Scene participants represent immediate narrative presence and do not by themselves change every participant's durable location.

## Resolve uncertainty

Before narrating a potentially contradictory fact, check the current context, then the affected entity, and only then the recent event history if the cause matters. Prefer stored state over uncertain chat recollection. Events explain how the current state arose; they do not override it.

## Close a session or chapter

Save outstanding durable changes and set the accurate current scene before creating a checkpoint. Create checkpoints with a player-safe `playerRecap` and optional GM-only `gmNotes`.

The player recap may contain only facts explicitly observed, learned, or reasonably known by the player characters. Include major decisions, revealed knowledge, visible consequences, the group's present situation, and immediate dangers or questions already apparent to them.

Store concealed identities, motives, causes, plans, locations, background developments, and unrevealed consequences only in GM notes, secret entities, or secret events. When uncertain, omit the detail from the player recap.

Treat checkpoint recaps as narrative save previews. Database entities and events remain authoritative for durable world state.
