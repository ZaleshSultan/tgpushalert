import {
  assertCronSecret,
  getAppTimezone,
  getOptionalEnv,
  getRequiredEnv,
  handleFunctionError,
  jsonResponse,
} from "../_shared/env.ts";
import { parseIcsCalendar } from "../_shared/ics.ts";
import {
  ensureSource,
  finishSyncRun,
  markMissingEvents,
  type SourceKind,
  startSyncRun,
  upsertExternalEvents,
} from "../_shared/supabase.ts";

interface IcsSourceConfig {
  kind: SourceKind;
  name: string;
  envName: string;
  missingEnvIsError: boolean;
  deriveDueAtFromStart: boolean;
  eventUrlPayloadKey: string;
}

interface IcsSyncResult {
  source_kind: SourceKind;
  source_name: string;
  source_id?: string;
  status: "success" | "skipped" | "error";
  skipped?: "source_disabled" | "missing_env";
  items_seen: number;
  items_upserted: number;
  missing: number;
  error?: string;
}

const ICS_SOURCES: IcsSourceConfig[] = [
  {
    kind: "moodle_ics",
    name: "Moodle LMS",
    envName: "MOODLE_ICS_URL",
    missingEnvIsError: true,
    deriveDueAtFromStart: true,
    eventUrlPayloadKey: "MOODLE_URL",
  },
  {
    kind: "personal_ics",
    name: "Personal Schedule",
    envName: "PERSONAL_ICS_URL",
    missingEnvIsError: false,
    deriveDueAtFromStart: false,
    eventUrlPayloadKey: "PERSONAL_URL",
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    assertCronSecret(req);

    const timeZone = getAppTimezone();
    const results: IcsSyncResult[] = [];
    for (const config of ICS_SOURCES) {
      results.push(await syncIcsSource(config, timeZone));
    }

    const failed = results.filter((result) => result.status === "error");
    return jsonResponse({
      ok: failed.length === 0,
      items_seen: sum(results, "items_seen"),
      items_upserted: sum(results, "items_upserted"),
      missing: sum(results, "missing"),
      sources: results,
    }, failed.length ? 500 : 200);
  } catch (error) {
    return handleFunctionError(error);
  }
});

async function syncIcsSource(
  config: IcsSourceConfig,
  timeZone: string,
): Promise<IcsSyncResult> {
  let runId: string | null = null;
  let itemsSeen = 0;
  let itemsUpserted = 0;
  let sourceId: string | undefined;

  try {
    const optionalIcsUrl = config.missingEnvIsError
      ? null
      : getOptionalEnv(config.envName);
    if (!config.missingEnvIsError && !optionalIcsUrl) {
      return {
        source_kind: config.kind,
        source_name: config.name,
        status: "skipped",
        skipped: "missing_env",
        items_seen: 0,
        items_upserted: 0,
        missing: 0,
      };
    }

    const source = await ensureSource(config.kind, config.name);
    sourceId = source.id;
    if (!source.is_enabled) {
      return {
        source_kind: config.kind,
        source_name: config.name,
        source_id: source.id,
        status: "skipped",
        skipped: "source_disabled",
        items_seen: 0,
        items_upserted: 0,
        missing: 0,
      };
    }

    const run = await startSyncRun(source.id);
    runId = run.id;

    const icsUrl = config.missingEnvIsError
      ? getRequiredEnv(config.envName)
      : optionalIcsUrl;
    if (!icsUrl) {
      throw new Error(
        `Missing required environment variable: ${config.envName}`,
      );
    }

    const response = await fetch(icsUrl, {
      headers: {
        accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
        "cache-control": "no-cache",
      },
    });
    if (!response.ok) {
      throw new Error(
        `${config.name} ICS fetch failed: HTTP ${response.status}`,
      );
    }

    const icsText = await response.text();
    const events = await parseIcsCalendar(icsText, {
      defaultTimeZone: timeZone,
      deriveDueAtFromStart: config.deriveDueAtFromStart,
    });
    itemsSeen = events.length;

    const rows = events.map((event) => ({
      source_id: source.id,
      external_id: event.external_id,
      title: event.title,
      description: event.description,
      location: event.location,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      due_at: event.due_at,
      raw_payload_json: {
        ...event.raw_payload_json,
        [config.eventUrlPayloadKey]: event.url,
      },
      checksum: event.checksum,
      status: "active" as const,
    }));

    const upserted = await upsertExternalEvents(rows);
    itemsUpserted = upserted.length;
    const missing = await markMissingEvents(
      source.id,
      new Set(events.map((event) => event.external_id)),
    );

    await finishSyncRun(run.id, "success", itemsSeen, itemsUpserted);
    return {
      source_kind: config.kind,
      source_name: config.name,
      source_id: source.id,
      status: "success",
      items_seen: itemsSeen,
      items_upserted: itemsUpserted,
      missing,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) {
      await finishSyncRun(runId, "error", itemsSeen, itemsUpserted, message);
    }

    return {
      source_kind: config.kind,
      source_name: config.name,
      ...(sourceId ? { source_id: sourceId } : {}),
      status: "error",
      items_seen: itemsSeen,
      items_upserted: itemsUpserted,
      missing: 0,
      error: message,
    };
  }
}

function sum(
  results: IcsSyncResult[],
  key: "items_seen" | "items_upserted" | "missing",
): number {
  return results.reduce((total, result) => total + result[key], 0);
}
