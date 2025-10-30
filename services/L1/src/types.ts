export type ItemId = string;
export type Namespace = string;

export interface ItemRecord {
  item_id: ItemId;   // persisted shape (always string)
  ns: Namespace;
  text: string;
  meta_json?: string;
  created_at: number;
  updated_at: number;
  ttl_s?: number;
  version: number;
}

// Use a separate type for write inputs (item_id is optional)
export interface UpsertItemArgs {
  ns: Namespace;
  text: string;
  meta_json?: string;
  ttl_s?: number;
  item_id?: ItemId;  // optional on input
}
