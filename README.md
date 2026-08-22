# MCP RPG Worldstate

Ein lokaler, systemneutraler MCP-Server, der einer KI-Spielleitung ein dauerhaftes Gedächtnis für Rollenspielwelten gibt. Er speichert erzählerische Inhalte überwiegend als Freitext und strukturiert nur das, was für Suche und Konsistenz wichtig ist: Weltzugehörigkeit, Entitätstypen, Orte, Szenen, Teilnehmer und aktive Zustände.

## Leitgedanke

Gespeichert werden dauerhafte oder erzählerisch relevante Fakten – nicht jede vorübergehende Beobachtung. Eine kaputte planetare Wettersteuerung kann wichtig sein; eine im Wind veränderte Frisur normalerweise nicht.

Der typische Abruf ist absichtlich gestuft:

1. `list_worlds` zeigt vorhandene Spielstände.
2. `get_world_overview` liefert eine kompakte Save-Preview.
3. `get_current_context` lädt die unmittelbar spielbare Szene.
4. `search_entities` holt nur bei Bedarf weitere Details.

Änderungen lassen sich mit `apply_world_changes` in einem einzigen atomaren Aufruf bündeln.

Neu angelegte Entitäten können sich innerhalb desselben Aufrufs über lokale Referenzen aufeinander beziehen. Ein kompaktes Ereignis- und Checkpoint-Archiv erklärt bei Bedarf, wie der aktuelle Zustand entstanden ist, ohne den autoritativen Weltzustand zu ersetzen.

## Voraussetzungen und Installation

- Node.js 24 oder neuer (für das integrierte SQLite-Modul)
- npm

```bash
npm install
npm run build
npm test
```

Der Server verwendet standardmäßig `rpg-worldstate.sqlite` im Arbeitsverzeichnis. Für einen stabilen, expliziten Speicherort sollte `RPG_WORLDSTATE_DB` als absoluter Pfad gesetzt werden.

## MCP-Konfiguration

Ein lokaler MCP-Client kann den Server über stdio starten. Das allgemeine Konfigurationsmuster lautet:

```json
{
  "mcpServers": {
    "rpg-worldstate": {
      "command": "node",
      "args": [
        "/home/eurobertics/projects/mcp_rpg_worldstate/dist/index.js"
      ],
      "env": {
        "RPG_WORLDSTATE_DB": "/home/eurobertics/projects/mcp_rpg_worldstate/rpg-worldstate.sqlite"
      }
    }
  }
}
```

Die genaue Stelle für diese Konfiguration hängt vom verwendeten MCP-Client ab. Der Server schreibt Protokollmeldungen ausschließlich nach stderr, damit das MCP-Protokoll auf stdout sauber bleibt.

### Claude Desktop unter Windows mit Server in WSL

Wenn Claude Desktop unter Windows läuft, der MCP-Server aber innerhalb von WSL installiert ist, kann Claude ihn über `wsl.exe` starten. Die Konfiguration befindet sich normalerweise unter:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

Beispiel:

```json
{
  "mcpServers": {
    "rpg-worldstate": {
      "command": "wsl.exe",
      "args": [
        "-d",
        "Ubuntu",
        "--exec",
        "bash",
        "-lc",
        "cd /home/eurobertics/projects/mcp_rpg_worldstate && RPG_WORLDSTATE_DB=/home/eurobertics/projects/mcp_rpg_worldstate/rpg-worldstate.sqlite exec node dist/index.js"
      ]
    }
  }
}
```

`Ubuntu` muss dem exakten Namen der verwendeten WSL-Distribution entsprechen. Die installierten Distributionen zeigt PowerShell mit folgendem Befehl an:

```powershell
wsl.exe --list --quiet
```

`bash -lc` lädt eine Login-Shell. Das ist insbesondere dann wichtig, wenn Node.js über einen Versionsmanager wie `fnm` oder `nvm` installiert wurde. Projekt- und Datenbankpfad sind Linux-Pfade innerhalb von WSL. Die vollständige Shell-Anweisung muss in der JSON-Konfiguration ein einzelnes Element von `args` bleiben.

Der Start lässt sich vor der Claude-Konfiguration direkt aus PowerShell prüfen:

```powershell
wsl.exe -d Ubuntu --exec bash -lc "cd /home/eurobertics/projects/mcp_rpg_worldstate && RPG_WORLDSTATE_DB=/home/eurobertics/projects/mcp_rpg_worldstate/rpg-worldstate.sqlite exec node dist/index.js"
```

Bei erfolgreichem Start erscheint auf stderr beispielsweise:

```text
mcp-rpg-worldstate is using /home/eurobertics/projects/mcp_rpg_worldstate/rpg-worldstate.sqlite
```

Der Prozess bleibt anschließend aktiv und wartet auf MCP-Nachrichten über stdin. Das ist das erwartete Verhalten. Nach einer Änderung der Konfigurationsdatei muss Claude Desktop vollständig beendet und neu gestartet werden.

> **ChatGPT-Hinweis:** Diese Konfiguration verwendet den lokalen `stdio`-Transport von Claude Desktop. Sie lässt sich nicht unverändert für ChatGPT Desktop übernehmen. Dafür müsste der Server zusätzlich über einen von ChatGPT unterstützten HTTP-Transport und eine erreichbare URL bereitgestellt werden.

## Werkzeuge

| Tool | Zweck |
|---|---|
| `list_worlds` | Kompakte Liste aller Spielstände |
| `create_world` | Neue isolierte Welt/Kampagne erstellen |
| `update_world` | Dauerhafte Weltbeschreibung oder Kurzfassung ändern |
| `delete_world` | Welt inklusive aller abhängigen Daten rekursiv löschen |
| `apply_world_changes` | Entitäten gesammelt erstellen, ändern oder löschen |
| `search_entities` | Charaktere, Orte, Plots, Notizen und Gegenstände suchen |
| `set_current_scene` | Aktuelle Szene und Teilnehmer kompakt festhalten |
| `get_world_overview` | Token-arme Save-Preview laden |
| `get_current_context` | Aktuellen spielbaren Kontext laden |
| `create_checkpoint` | Spielersicheren Rückblick und optionale GM-Notizen speichern |
| `get_recent_events` | Relevante Ereignisse paginiert oder seit einem Checkpoint lesen |
| `list_checkpoints` | Ältere Session- und Kapitelstände paginiert laden |
| `random_numbers` | Neutrale Zufallszahlen für erzählerische Entscheidungen |

Entitätstypen sind `character`, `location`, `plot`, `note` und `item`. Ein Charakter oder Gegenstand kann über `locationId` einen aktuellen Ort erhalten. Orte können mit `parentId` verschachtelt werden. Szenenteilnahme ist davon getrennt: Ein kurzer gemeinsamer Szenenwechsel muss nicht automatisch alle dauerhaften Aufenthaltsorte verändern.

### Lokale Referenzen in einem Batch

Create-Operationen können eine innerhalb des Aufrufs eindeutige `ref` definieren. Andere Änderungen dürfen diese mit `locationRef` oder `parentRef` verwenden, auch wenn die referenzierte Create-Operation später im Array steht:

```json
{
  "worldId": 1,
  "changes": [
    {
      "action": "create",
      "ref": "mara",
      "kind": "character",
      "name": "Mara",
      "locationRef": "tavern"
    },
    {
      "action": "create",
      "ref": "cellar",
      "kind": "location",
      "name": "Weinkeller",
      "parentRef": "tavern"
    },
    {
      "action": "create",
      "ref": "tavern",
      "kind": "location",
      "name": "Zum hinkenden Drachen"
    }
  ],
  "summary": "Mara und ihr Gasthaus wurden eingeführt."
}
```

Die Antwort enthält `createdRefs` mit den erzeugten numerischen IDs. Unbekannte, doppelte oder zirkuläre Referenzen sowie die gleichzeitige Angabe von beispielsweise `locationId` und `locationRef` brechen die gesamte Transaktion ab.

### Ereignisse, Geheimnisse und Checkpoints

Eine `summary` in `apply_world_changes` erzeugt einen kompakten historischen Ereigniseintrag. Sobald der Batch eine geheime Entität betrifft, muss die Zusammenfassung mit `eventSecret: true` als geheim markiert oder weggelassen werden. So kann keine geheime Änderung versehentlich in der öffentlichen Ereignishistorie erscheinen.

`get_recent_events` liefert Ereignisse standardmäßig in der Reihenfolge `id DESC`, unterstützt `beforeId` zur rückwärtsgerichteten Pagination, Textsuche und `sinceCheckpointId`. Jeder Checkpoint speichert intern den damaligen Ereignisstand, sodass „Was geschah seit diesem Checkpoint?“ eindeutig beantwortet werden kann.

`list_checkpoints` liefert ältere Checkpoints ebenfalls neueste zuerst und paginiert über `beforeId`.

#### Spielersichere Checkpoints

Jeder neue Checkpoint trennt zwei Informationskanäle:

```json
{
  "worldId": 1,
  "title": "Die Nacht im hinkenden Drachen",
  "playerRecap": "Bernd fand im Keller eine königliche Münze. Mara behauptete, sie noch nie gesehen zu haben.",
  "gmNotes": "Mara ist die verschwundene Königin."
}
```

- `playerRecap` ist verpflichtend und ausschließlich für bereits beobachtete, enthüllte oder vernünftigerweise bekannte Tatsachen bestimmt.
- `gmNotes` ist optional und immer ausschließlich für den Gamemaster bestimmt.
- Verborgene Identitäten, Motive, Ursachen, Pläne, Orte und zukünftige Entwicklungen gehören niemals in `playerRecap`.
- Im Zweifel gehört eine Information in `gmNotes`, eine geheime Entität oder ein geheimes Event – nicht in den öffentlichen Rückblick.

Der Server klassifiziert, bereinigt oder formuliert Inhalte nicht automatisch um. Die aufrufende KI ist für die richtige Einordnung verantwortlich. Entitäten und Events bleiben die autoritative Quelle; Checkpoints sind kompakte narrative Save-Previews.

`get_world_overview` und `list_checkpoints` geben standardmäßig ausschließlich `playerRecap` zurück. `gmNotes` wird nur bei `includeSecrets: true` als separates Feld ausgegeben. Diese Option darf nur in einem berechtigten Gamemaster-Kontext verwendet werden. Beide Texte werden vom Server niemals zusammengeführt.

Die frühere Eingabe `summary` für `create_checkpoint` wird nicht mehr akzeptiert. Dadurch muss jeder neue Client ausdrücklich einen spielersicheren Rückblick erstellen.

### Datenbankmigrationen

Das Schema wird über SQLite `PRAGMA user_version` versioniert. Beim Serverstart werden ältere Datenbanken automatisch innerhalb von Transaktionen auf den aktuellen Stand migriert. Alte Checkpoint-`summary`-Inhalte gelten vorsichtshalber als potenziell geheim: Sie werden nach `gmNotes` übernommen und öffentlich nur durch einen neutralen Hinweis ersetzt. Eine alte Zusammenfassung wird niemals automatisch als Spielerwissen veröffentlicht. Vor einem Versionswechsel empfiehlt sich trotzdem eine Sicherung der SQLite-Datei.

## Optionale Codex-Skill

Unter `skills/rpg-worldstate-gm` liegt eine kleine begleitende Skill mit Regeln für sparsames Laden, relevante Zustandsänderungen, Geheimnisse und Checkpoints. Sie ist nicht für den MCP-Server oder andere Clients erforderlich.

Zur lokalen Installation kann der Ordner in das persönliche Codex-Skill-Verzeichnis kopiert werden:

```bash
cp -R skills/rpg-worldstate-gm ~/.codex/skills/
```

## Löschen und Konsistenz

`delete_world` verlangt zur Sicherheit die exakte Bestätigung `DELETE: <Weltname>`. Danach entfernt SQLite über Foreign-Key-Cascades alle Charaktere, Orte, Plots, Szenen, Checkpoints und Ereignisse dieser Welt.

Verknüpfungen zwischen verschiedenen Welten werden abgelehnt. Gebündelte Änderungen laufen in einer Transaktion: Ist eine Änderung ungültig, wird keine davon gespeichert.

## Entwicklung

```bash
npm run dev
npm run check
npm test
```

Die wichtigsten Dateien sind:

- `src/store.ts`: SQLite-Schema, Validierung und Abfragen
- `src/server.ts`: öffentliche MCP-Tools und Eingabeschemata
- `src/index.ts`: lokaler stdio-Einstiegspunkt
- `src/*.test.ts`: Datenbank- und MCP-Protokolltests
