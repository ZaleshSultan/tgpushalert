import {
  assertCronSecret,
  getOptionalEnv,
  getRequiredEnv,
  handleFunctionError,
  jsonResponse,
} from "../_shared/env.ts";
import { sha256Hex } from "../_shared/checksum.ts";
import { fetchTextWithTimeout } from "../_shared/http.ts";
import {
  ensureSource,
  type ExternalEventUpsert,
  finishSyncRun,
  markMissingEvents,
  startSyncRun,
  upsertExternalEvents,
} from "../_shared/supabase.ts";

const SOURCE_KIND = "steam_wishlist";
const SOURCE_NAME = "Steam Wishlist";
const DEFAULT_COUNTRY = "KZ";
const DEFAULT_LOCALE = "russian";

interface SyncResponse {
  success: boolean;
  ok: boolean;
  source_kind: typeof SOURCE_KIND;
  source_id?: string;
  processed: number;
  upserted: number;
  skipped: number;
  missing: number;
  errors: string[];
}

interface DiscountedSteamSub {
  sub: Record<string, unknown>;
  discountPct: number;
  finalPrice: number | null;
  originalPrice: number | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    assertCronSecret(req);
    const result = await syncSteamWishlist();
    return jsonResponse(result, result.success ? 200 : 500);
  } catch (error) {
    return handleFunctionError(error);
  }
});

async function syncSteamWishlist(): Promise<SyncResponse> {
  let runId: string | null = null;
  let sourceId: string | undefined;
  let processed = 0;
  let upserted = 0;
  let skipped = 0;

  try {
    const source = await ensureSource(SOURCE_KIND, SOURCE_NAME);
    sourceId = source.id;

    if (!source.is_enabled) {
      return {
        success: true,
        ok: true,
        source_kind: SOURCE_KIND,
        source_id: source.id,
        processed: 0,
        upserted: 0,
        skipped: 1,
        missing: 0,
        errors: [],
      };
    }

    const run = await startSyncRun(source.id);
    runId = run.id;

    const steamId = getRequiredEnv("STEAM_ID64");
    const country = getOptionalEnv("STEAM_COUNTRY", DEFAULT_COUNTRY)
      .trim()
      .toUpperCase() || DEFAULT_COUNTRY;
    const locale = getOptionalEnv("STEAM_LOCALE", DEFAULT_LOCALE).trim() ||
      DEFAULT_LOCALE;
    const url = steamWishlistUrl(steamId, country, locale);
    const body = await fetchTextWithTimeout(url, {
      label: "Steam wishlist fetch",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        "cache-control": "no-cache",
        "user-agent": "Life OS Alert Bot Steam Wishlist Sync",
      },
    });

    const wishlist = parseWishlistJson(body);
    const nowIso = new Date().toISOString();
    const rows: ExternalEventUpsert[] = [];

    for (const [appId, game] of Object.entries(wishlist)) {
      processed += 1;
      if (!isRecord(game)) {
        skipped += 1;
        continue;
      }

      const bestSub = bestDiscountedSub(game);
      if (!bestSub) {
        skipped += 1;
        continue;
      }

      rows.push(
        await steamGameToEventRow({
          sourceId: source.id,
          appId,
          game,
          sub: bestSub,
          nowIso,
          country,
          locale,
        }),
      );
    }

    const resultRows = await upsertExternalEvents(rows);
    upserted = resultRows.length;
    const missing = await markMissingEvents(
      source.id,
      new Set(rows.map((row) => row.external_id)),
    );

    await finishSyncRun(run.id, "success", processed, upserted);
    return {
      success: true,
      ok: true,
      source_kind: SOURCE_KIND,
      source_id: source.id,
      processed,
      upserted,
      skipped,
      missing,
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) {
      await finishSyncRun(runId, "error", processed, upserted, message);
    }
    return {
      success: false,
      ok: false,
      source_kind: SOURCE_KIND,
      ...(sourceId ? { source_id: sourceId } : {}),
      processed,
      upserted,
      skipped,
      missing: 0,
      errors: [message],
    };
  }
}

function steamWishlistUrl(
  steamId: string,
  country: string,
  locale: string,
): string {
  const params = new URLSearchParams({
    cc: country || DEFAULT_COUNTRY,
    l: locale || DEFAULT_LOCALE,
  });
  return `https://store.steampowered.com/wishlist/profiles/${
    encodeURIComponent(steamId)
  }/wishlistdata/?${params.toString()}`;
}

function parseWishlistJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Steam wishlist returned invalid JSON. Check that STEAM_ID64 points to an open public wishlist. ${message}`,
    );
  }

  if (isRecord(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    return {};
  }

  throw new Error(
    "Steam wishlist response was not an object. The wishlist may be private or unavailable.",
  );
}

function bestDiscountedSub(
  game: Record<string, unknown>,
): DiscountedSteamSub | null {
  const subs = Array.isArray(game.subs) ? game.subs : [];
  const discounted = subs
    .filter(isRecord)
    .map((sub) => ({
      sub,
      discountPct: numberValue(sub.discount_pct) || 0,
      finalPrice: numberValue(sub.discount_price) ??
        numberValue(sub.final_price) ??
        numberValue(sub.discounted_price) ??
        discountBlockFinalPrice(sub) ??
        numberValue(sub.price),
      originalPrice: numberValue(sub.original_price) ??
        numberValue(sub.orig_price),
    }))
    .filter((sub) => sub.discountPct > 0);

  discounted.sort((left, right) => {
    const discountDiff = right.discountPct - left.discountPct;
    if (discountDiff !== 0) {
      return discountDiff;
    }

    return priceForSort(left.finalPrice) - priceForSort(right.finalPrice);
  });

  return discounted[0] || null;
}

async function steamGameToEventRow(params: {
  sourceId: string;
  appId: string;
  game: Record<string, unknown>;
  sub: DiscountedSteamSub;
  nowIso: string;
  country: string;
  locale: string;
}): Promise<ExternalEventUpsert> {
  const { sourceId, appId, game, sub, nowIso, country, locale } = params;
  const gameName = stringValue(game.name) || `Steam app ${appId}`;
  const storeUrl = `https://store.steampowered.com/app/${
    encodeURIComponent(appId)
  }`;
  const priceLine = steamPriceLine(sub);
  const checksum = await sha256Hex([
    SOURCE_KIND,
    appId,
    sub.discountPct,
    sub.finalPrice ?? "",
  ].join("|"));

  return {
    source_id: sourceId,
    external_id: appId,
    title: `🎮 Steam скидка: ${gameName} — -${sub.discountPct}%`,
    description: [
      `Игра: ${gameName}`,
      `Скидка: -${sub.discountPct}%`,
      priceLine ? `Цена: ${priceLine}` : null,
      `Ссылка: ${storeUrl}`,
    ].filter(Boolean).join("\n"),
    location: null,
    starts_at: null,
    ends_at: null,
    due_at: nowIso,
    due_date: null,
    has_explicit_time: true,
    remind_at: null,
    raw_payload_json: {
      source_kind: SOURCE_KIND,
      app_id: appId,
      name: gameName,
      selected_sub: sub.sub,
      country,
      locale,
      store_url: storeUrl,
    },
    checksum,
    status: "active",
  };
}

function steamPriceLine(sub: DiscountedSteamSub): string | null {
  const finalText = stringValue(sub.sub.formatted_price) ||
    stringValue(sub.sub.formatted_final_price) ||
    discountBlockText(sub.sub, "discount_final_price") ||
    formatKztMinor(sub.finalPrice);
  const originalText = stringValue(sub.sub.formatted_orig_price) ||
    stringValue(sub.sub.formatted_original_price) ||
    discountBlockText(sub.sub, "discount_original_price") ||
    formatKztMinor(sub.originalPrice);

  if (finalText && originalText) {
    return `${finalText} (было ${originalText})`;
  }
  return finalText || originalText;
}

function discountBlockFinalPrice(sub: Record<string, unknown>): number | null {
  const html = stringValue(sub.discount_block);
  if (!html) {
    return null;
  }
  const match = html.match(/\bdata-price-final=["']?(\d+)/i);
  return match ? numberValue(match[1]) : null;
}

function discountBlockText(
  sub: Record<string, unknown>,
  className: string,
): string | null {
  const html = stringValue(sub.discount_block);
  if (!html) {
    return null;
  }

  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `<[^>]*class=["'][^"']*${escapedClass}[^"']*["'][^>]*>(.*?)</[^>]+>`,
      "i",
    ),
  );
  if (!match) {
    return null;
  }

  return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim() || null;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, body) => {
    const key = String(body).toLowerCase();
    if (key.startsWith("#x")) {
      return decodeCodePoint(Number.parseInt(key.slice(2), 16), entity);
    }
    if (key.startsWith("#")) {
      return decodeCodePoint(Number.parseInt(key.slice(1), 10), entity);
    }
    return namedEntities[key] || entity;
  });
}

function decodeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint)) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function priceForSort(value: number | null): number {
  return value ?? Number.POSITIVE_INFINITY;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatKztMinor(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "KZT",
  }).format(value / 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
