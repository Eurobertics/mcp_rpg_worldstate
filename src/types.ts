export const ENTITY_KINDS = ["character", "location", "plot", "note", "item"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityInput {
  kind: EntityKind;
  name: string;
  description?: string;
  status?: string;
  role?: string;
  locationId?: number | null;
  parentId?: number | null;
  active?: boolean;
  secret?: boolean;
}

export interface EntityLinks {
  locationRef?: string;
  parentRef?: string;
}

export type Change =
  | ({ action: "create"; ref?: string } & EntityInput & EntityLinks)
  | ({ action: "update"; entityId: number } & Partial<EntityInput> & EntityLinks)
  | { action: "delete"; entityId: number };

export interface ApplyChangesResult {
  results: Record<string, unknown>[];
  createdRefs: Record<string, number>;
}
