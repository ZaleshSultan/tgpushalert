import { getRequiredEnv } from "./env.ts";

export type SourceKind =
  | "google_tasks"
  | "google_calendar"
  | "moodle_ics"
  | "personal_ics"
  | "personal_tasks";

export interface SourceRow {
  id: string;
  kind: SourceKind;
  name: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ExternalEventRow {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  due_at: string | null;
  due_date?: string | null;
  has_explicit_time?: boolean;
  remind_at?: string | null;
  effective_at?: string | null;
  alert_at?: string | null;
  raw_payload_json: Record<string, unknown>;
  checksum: string | null;
  status: "active" | "missing" | "done" | "cancelled";
  created_at: string;
  updated_at: string;
  sources?: Pick<SourceRow, "kind" | "name">;
}

export interface ExternalEventUpsert {
  source_id: string;
  external_id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  due_at?: string | null;
  due_date?: string | null;
  has_explicit_time?: boolean;
  remind_at?: string | null;
  raw_payload_json?: Record<string, unknown>;
  checksum?: string | null;
  status?: "active" | "missing" | "done" | "cancelled";
}

export interface NotificationStateRow {
  id: string;
  event_id: string;
  alert_type: string;
  event_checksum: string | null;
  notified_at: string | null;
  cooldown_until: string | null;
}

export interface MutedItemRow {
  id: string;
  item_kind: string;
  item_ref: string;
  muted_until: string;
  reason: string | null;
  created_at: string;
}

export interface SyncRunRow {
  id: string;
  source_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "error";
  items_seen: number;
  items_upserted: number;
  error_text: string | null;
}

type RequestOptions = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
};

function apiUrl(path: string): string {
  const base = getRequiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  return `${base}/rest/v1/${path}`;
}

export async function supabaseRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = new Headers(options.headers);
  headers.set("apikey", serviceRoleKey);
  headers.set("authorization", `Bearer ${serviceRoleKey}`);
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase REST ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  const text = await response.text();
  return text ? JSON.parse(text) as T : null as T;
}

export function queryString(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

export async function ensureSource(
  kind: SourceKind,
  name: string,
): Promise<SourceRow> {
  const existingParams = queryString({
    select: "*",
    kind: `eq.${kind}`,
    name: `eq.${name}`,
    limit: 1,
  });
  const existing = await supabaseRequest<SourceRow[]>(
    `sources?${existingParams}`,
  );
  if (existing[0]) {
    return existing[0];
  }

  const rows = await supabaseRequest<SourceRow[]>("sources", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify([{ kind, name, is_enabled: true }]),
  });
  return rows[0];
}

export async function startSyncRun(
  sourceId: string | null,
): Promise<SyncRunRow> {
  const rows = await supabaseRequest<SyncRunRow[]>("sync_runs", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify([{ source_id: sourceId, status: "running" }]),
  });
  return rows[0];
}

export async function finishSyncRun(
  runId: string,
  status: "success" | "error",
  itemsSeen: number,
  itemsUpserted: number,
  errorText?: string,
): Promise<void> {
  const params = queryString({ id: `eq.${runId}` });
  await supabaseRequest<null>(`sync_runs?${params}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      finished_at: new Date().toISOString(),
      status,
      items_seen: itemsSeen,
      items_upserted: itemsUpserted,
      error_text: errorText || null,
    }),
  });
}

export async function upsertExternalEvents(
  rows: ExternalEventUpsert[],
): Promise<ExternalEventRow[]> {
  if (rows.length === 0) {
    return [];
  }

  const params = queryString({ on_conflict: "source_id,external_id" });
  return await supabaseRequest<ExternalEventRow[]>(
    `external_events?${params}`,
    {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(rows),
    },
  );
}

export async function markMissingEvents(
  sourceId: string,
  seenExternalIds: Set<string>,
): Promise<number> {
  const params = queryString({
    select: "id,external_id",
    source_id: `eq.${sourceId}`,
    status: "eq.active",
  });
  const existing = await supabaseRequest<
    Array<Pick<ExternalEventRow, "id" | "external_id">>
  >(
    `external_events?${params}`,
  );
  const missingIds = existing
    .filter((row) => !seenExternalIds.has(row.external_id))
    .map((row) => row.id);

  if (missingIds.length === 0) {
    return 0;
  }

  const idFilter = `in.(${missingIds.join(",")})`;
  await supabaseRequest<null>(
    `external_events?${queryString({ id: idFilter })}`,
    {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: "missing" }),
    },
  );
  return missingIds.length;
}
