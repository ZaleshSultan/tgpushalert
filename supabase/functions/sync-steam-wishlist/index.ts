import {
  assertCronSecret,
  getOptionalEnv,
  getRequiredEnv,
  handleFunctionError,
  jsonResponse,
} from "../_shared/env.ts";
import { sha256Hex } from "../_shared/checksum.ts";
import { classifyDeal, type DealKind } from "../_shared/deals.ts";
import { fetchJsonWithTimeout, fetchTextWithTimeout } from "../_shared/http.ts";
import {
  resolveSteamDeal,
  type SteamPriceCandidate,
} from "../_shared/steam.ts";
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
const APPDETAILS_CONCURRENCY = 5;
const STEAM_HEADERS = {
  accept: "application/json, text/html;q=0.9, */*;q=0.1",
  "cache-control": "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LifeOSAlertBot/1.0 Chrome/124.0 Safari/537.36",
};

type FetchMode = "wishlistdata" | "html_appdetails_fallback";

interface SyncResponse {
  success: boolean;
  ok: boolean;
  source_kind: typeof SOURCE_KIND;
  source_id?: string;
  fetch_mode?: FetchMode;
  processed: number;
  upserted: number;
  skipped: number;
  missing: number;
  errors: string[];
}

interface SteamConfig {
  steamId: string | null;
  vanity: string | null;
  country: string;
  locale: string;
}

interface BuildRowsResult {
  fetchMode: FetchMode;
  rows: ExternalEventUpsert[];
  processed: number;
  skipped: number;
  cleanupExternalIds: Set<string>;
  errors: string[];
}

interface DiscountedSteamOffer {
  raw: Record<string, unknown>;
  discountPct: number;
  finalPriceMinor: number | null;
  originalPriceMinor: number | null;
  finalFormatted: string | null;
  originalFormatted: string | null;
}

interface SteamWishlistServiceResponse {
  response?: {
    items?: unknown[];
  };
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
  let fetchMode: FetchMode | undefined;
  const errors: string[] = [];

  try {
    const source = await ensureSource(SOURCE_KIND, SOURCE_NAME);
    sourceId = source.id;

    if (!source.is_enabled) {
      console.log("[sync-steam-wishlist] source disabled");
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

    const config = steamConfig();
    console.log("[sync-steam-wishlist] started", {
      sourceId: source.id,
      steamId: config.steamId,
      vanity: config.vanity,
      country: config.country,
      locale: config.locale,
    });

    let result: BuildRowsResult;
    try {
      result = await buildRowsFromWishlistData(source.id, config);
    } catch (error) {
      const message = `wishlistdata: ${errorMessage(error)}`;
      console.warn("[sync-steam-wishlist] wishlistdata failed", { message });
      errors.push(message);
      result = await buildRowsFromHtmlFallback(source.id, config);
    }

    fetchMode = result.fetchMode;
    processed = result.processed;
    skipped = result.skipped;
    errors.push(...result.errors);

    const rows = result.rows;
    const resultRows = await upsertExternalEvents(rows);
    upserted = resultRows.length;
    const missing = await markMissingEvents(
      source.id,
      result.cleanupExternalIds,
    );

    console.log("[sync-steam-wishlist] completed", {
      fetchMode,
      processed,
      upserted,
      skipped,
      missing,
      errors: errors.length,
    });

    await finishSyncRun(run.id, "success", processed, upserted);
    return {
      success: true,
      ok: true,
      source_kind: SOURCE_KIND,
      source_id: source.id,
      fetch_mode: fetchMode,
      processed,
      upserted,
      skipped,
      missing,
      errors,
    };
  } catch (error) {
    const message = errorMessage(error);
    console.error("[sync-steam-wishlist] failed", {
      message,
      processed,
      upserted,
      skipped,
      fetchMode,
    });
    if (runId) {
      await finishSyncRun(runId, "error", processed, upserted, message);
    }
    return {
      success: false,
      ok: false,
      source_kind: SOURCE_KIND,
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(fetchMode ? { fetch_mode: fetchMode } : {}),
      processed,
      upserted,
      skipped,
      missing: 0,
      errors: [...errors, message],
    };
  }
}

function steamConfig(): SteamConfig {
  const vanity = getOptionalEnv("STEAM_VANITY").trim() || null;
  const steamId = vanity
    ? getOptionalEnv("STEAM_ID64").trim() || null
    : getRequiredEnv("STEAM_ID64").trim();
  if (!vanity && !steamId) {
    throw new Error("Missing required environment variable: STEAM_ID64");
  }
  const country = getOptionalEnv("STEAM_COUNTRY", DEFAULT_COUNTRY)
    .trim()
    .toUpperCase() || DEFAULT_COUNTRY;
  const locale = getOptionalEnv("STEAM_LOCALE", DEFAULT_LOCALE).trim() ||
    DEFAULT_LOCALE;

  return {
    steamId,
    vanity,
    country,
    locale,
  };
}

async function buildRowsFromWishlistData(
  sourceId: string,
  config: SteamConfig,
): Promise<BuildRowsResult> {
  const body = await fetchTextWithTimeout(steamWishlistDataUrl(config), {
    label: "Steam wishlistdata fetch",
    headers: STEAM_HEADERS,
  });

  const wishlist = parseWishlistJson(body);
  const nowIso = new Date().toISOString();
  const rows: ExternalEventUpsert[] = [];
  const errors: string[] = [];
  let processed = 0;
  let skipped = 0;

  for (const [appId, game] of Object.entries(wishlist)) {
    processed += 1;
    if (!isRecord(game)) {
      skipped += 1;
      continue;
    }

    const candidate = bestDiscountedSub(game);
    if (!candidate) {
      skipped += 1;
      continue;
    }

    try {
      const resolved = await resolveSteamDeal(appId, {
        country: config.country,
        locale: config.locale,
        headers: STEAM_HEADERS,
      }, steamPriceCandidate(candidate));
      if (!resolved) {
        skipped += 1;
        continue;
      }

      const dealKind = classifyDeal({
        finalPriceKzt: resolved.finalPriceKzt,
        discountPercent: resolved.discountPercent,
      });
      if (dealKind === "ignore") {
        skipped += 1;
        continue;
      }

      rows.push(
        await steamDiscountEventRow({
          sourceId,
          appId,
          name: stringValue(game.name) || resolved.name ||
            `Игра Steam ${appId}`,
          resolved,
          dealKind,
          nowIso,
          country: config.country,
          locale: config.locale,
          fetchMode: "wishlistdata",
          sourcePayload: {
            wishlist_game: game,
            selected_sub: candidate.raw,
          },
        }),
      );
    } catch (error) {
      skipped += 1;
      const message = `wishlist app ${appId}: ${errorMessage(error)}`;
      console.warn("[sync-steam-wishlist] item parse error", {
        appId,
        message,
      });
      errors.push(message);
    }
  }

  return {
    fetchMode: "wishlistdata",
    rows,
    processed,
    skipped,
    cleanupExternalIds: new Set(rows.map((row) => row.external_id)),
    errors,
  };
}

async function buildRowsFromHtmlFallback(
  sourceId: string,
  config: SteamConfig,
): Promise<BuildRowsResult> {
  const html = await fetchTextWithTimeout(steamWishlistPageUrl(config), {
    label: "Steam wishlist page fetch",
    headers: STEAM_HEADERS,
  });
  const appIds = await fallbackWishlistAppIds(html, config);
  if (appIds.length === 0) {
    throw new Error(
      "Steam wishlist page fallback did not expose any app ids in HTML",
    );
  }

  const nowIso = new Date().toISOString();
  const rows: ExternalEventUpsert[] = [];
  const cleanupExternalIds = new Set<string>();
  const errors: string[] = [];
  let skipped = 0;

  for (let index = 0; index < appIds.length; index += APPDETAILS_CONCURRENCY) {
    const batch = appIds.slice(index, index + APPDETAILS_CONCURRENCY);
    const results = await Promise.all(
      batch.map((appId) =>
        htmlFallbackEventRow({
          sourceId,
          appId,
          nowIso,
          config,
        })
      ),
    );

    for (const result of results) {
      if (result.row) {
        rows.push(result.row);
        cleanupExternalIds.add(result.row.external_id);
        continue;
      }
      if (result.keepActive) {
        cleanupExternalIds.add(result.appId);
      }
      skipped += 1;
      if (result.error) {
        console.warn("[sync-steam-wishlist] html fallback parse error", {
          appId: result.appId,
          message: result.error,
        });
        errors.push(result.error);
      }
    }
  }

  return {
    fetchMode: "html_appdetails_fallback",
    rows,
    processed: appIds.length,
    skipped,
    cleanupExternalIds,
    errors,
  };
}

async function htmlFallbackEventRow(params: {
  sourceId: string;
  appId: string;
  nowIso: string;
  config: SteamConfig;
}): Promise<{
  appId: string;
  row: ExternalEventUpsert | null;
  keepActive: boolean;
  error: string | null;
}> {
  const { sourceId, appId, nowIso, config } = params;
  try {
    const resolved = await resolveSteamDeal(appId, {
      country: config.country,
      locale: config.locale,
      headers: STEAM_HEADERS,
    });
    if (!resolved) {
      return { appId, row: null, keepActive: false, error: null };
    }

    const dealKind = classifyDeal({
      finalPriceKzt: resolved.finalPriceKzt,
      discountPercent: resolved.discountPercent,
    });
    if (dealKind === "ignore") {
      return { appId, row: null, keepActive: false, error: null };
    }

    return {
      appId,
      row: await steamDiscountEventRow({
        sourceId,
        appId,
        name: resolved.name || `Игра Steam ${appId}`,
        resolved,
        dealKind,
        nowIso,
        country: config.country,
        locale: config.locale,
        fetchMode: "html_appdetails_fallback",
        sourcePayload: {},
      }),
      keepActive: false,
      error: null,
    };
  } catch (error) {
    return {
      appId,
      row: null,
      keepActive: true,
      error: `html fallback ${appId}: ${errorMessage(error)}`,
    };
  }
}

async function fallbackWishlistAppIds(
  html: string,
  config: SteamConfig,
): Promise<string[]> {
  const htmlAppIds = extractWishlistAppIds(html);
  if (htmlAppIds.length > 0) {
    return htmlAppIds;
  }

  const steamId = config.steamId || extractSteamIdFromWishlistHtml(html);
  if (!steamId) {
    return [];
  }

  return await fetchWishlistServiceAppIds(steamId);
}

function steamWishlistDataUrl(config: SteamConfig): string {
  const params = new URLSearchParams({
    cc: config.country,
    l: config.locale,
  });
  const profilePath = config.vanity
    ? `id/${encodeURIComponent(config.vanity)}`
    : `profiles/${encodeURIComponent(config.steamId || "")}`;
  return `https://store.steampowered.com/wishlist/${profilePath}/wishlistdata/?${params.toString()}`;
}

function steamWishlistPageUrl(config: SteamConfig): string {
  const profilePath = config.vanity
    ? `id/${encodeURIComponent(config.vanity)}`
    : `profiles/${encodeURIComponent(config.steamId || "")}`;
  return `https://store.steampowered.com/wishlist/${profilePath}/`;
}

function parseWishlistJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Steam wishlist returned invalid JSON. Check that STEAM_VANITY or STEAM_ID64 points to an open public wishlist. ${message}`,
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
): DiscountedSteamOffer | null {
  const subs = Array.isArray(game.subs) ? game.subs : [];
  const discounted = subs
    .filter(isRecord)
    .map((sub) => ({
      raw: sub,
      discountPct: numberValue(sub.discount_pct) || 0,
      finalPriceMinor: numberValue(sub.discount_price) ??
        numberValue(sub.final_price) ??
        numberValue(sub.discounted_price) ??
        discountBlockFinalPrice(sub) ??
        numberValue(sub.price),
      originalPriceMinor: numberValue(sub.original_price) ??
        numberValue(sub.orig_price),
      finalFormatted: stringValue(sub.formatted_price) ||
        stringValue(sub.formatted_final_price) ||
        discountBlockText(sub, "discount_final_price"),
      originalFormatted: stringValue(sub.formatted_orig_price) ||
        stringValue(sub.formatted_original_price) ||
        discountBlockText(sub, "discount_original_price"),
    }))
    .filter((sub) => sub.discountPct > 0);

  discounted.sort((left, right) => {
    const discountDiff = right.discountPct - left.discountPct;
    if (discountDiff !== 0) {
      return discountDiff;
    }

    return priceForSort(left.finalPriceMinor) -
      priceForSort(right.finalPriceMinor);
  });

  return discounted[0] || null;
}

function steamPriceCandidate(offer: DiscountedSteamOffer): SteamPriceCandidate {
  return {
    discountPercent: offer.discountPct,
    finalPriceMinor: offer.finalPriceMinor,
    originalPriceMinor: offer.originalPriceMinor,
    finalFormatted: offer.finalFormatted,
    originalFormatted: offer.originalFormatted,
    raw: offer.raw,
  };
}

async function fetchWishlistServiceAppIds(steamId: string): Promise<string[]> {
  const params = new URLSearchParams({
    steamid: steamId,
    include_appinfo: "0",
    include_free_sub: "1",
  });
  const payload = await fetchJsonWithTimeout<SteamWishlistServiceResponse>(
    `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?${params.toString()}`,
    {
      label: "Steam wishlist service fetch",
      headers: STEAM_HEADERS,
    },
  );
  const items = Array.isArray(payload.response?.items)
    ? payload.response.items
    : [];
  const ids = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const appId = numberValue(item.appid);
    if (appId !== null && appId > 0) {
      ids.add(String(appId));
    }
  }
  return [...ids];
}

async function steamDiscountEventRow(params: {
  sourceId: string;
  appId: string;
  name: string;
  resolved: Awaited<ReturnType<typeof resolveSteamDeal>> extends infer T
    ? Exclude<T, null>
    : never;
  dealKind: Exclude<DealKind, "ignore">;
  nowIso: string;
  country: string;
  locale: string;
  fetchMode: FetchMode;
  sourcePayload: Record<string, unknown>;
}): Promise<ExternalEventUpsert> {
  const {
    sourceId,
    appId,
    name,
    resolved,
    dealKind,
    nowIso,
    country,
    locale,
    fetchMode,
    sourcePayload,
  } = params;
  const checksum = await sha256Hex([
    SOURCE_KIND,
    appId,
    dealKind,
    resolved.discountPercent,
    resolved.finalPriceKzt,
    resolved.originalPriceKzt,
  ].join("|"));

  return {
    source_id: sourceId,
    external_id: appId,
    title: name,
    description: [
      `Игра: ${name}`,
      `Цена: ${
        formatPriceLine(resolved.finalPriceKzt, resolved.originalPriceKzt)
      }`,
      `Скидка: ${resolved.discountPercent}%`,
      `Ссылка: ${resolved.storeUrl}`,
    ].join("\n"),
    location: null,
    starts_at: null,
    ends_at: null,
    due_at: null,
    due_date: null,
    has_explicit_time: true,
    remind_at: nowIso,
    raw_payload_json: {
      source_kind: SOURCE_KIND,
      fetch_mode: fetchMode,
      price_source: resolved.source,
      deal_kind: dealKind,
      store: "steam",
      app_id: appId,
      name,
      final_price_kzt: resolved.finalPriceKzt,
      original_price_kzt: resolved.originalPriceKzt,
      discount_percent: resolved.discountPercent,
      store_url: resolved.storeUrl,
      country,
      locale,
      should_create_google_task: dealKind === "free",
      should_push_telegram: true,
      steam_price: resolved.raw,
      ...sourcePayload,
    },
    checksum,
    status: "active",
  };
}

function extractWishlistAppIds(html: string): string[] {
  const ids = new Set<string>();
  const addId = (value: string) => {
    if (/^\d{2,10}$/.test(value) && Number(value) > 0) {
      ids.add(value);
    }
  };
  const addIdsFromValue = (value: string) => {
    for (const match of value.matchAll(/\b(\d{2,10})\b/g)) {
      addId(match[1]);
    }
  };

  for (
    const pattern of [
      /\bdata-app-id\s*=\s*["']([^"']+)["']/gi,
      /\bdata-ds-appid\s*=\s*["']([^"']+)["']/gi,
    ]
  ) {
    for (const match of html.matchAll(pattern)) {
      addIdsFromValue(match[1]);
    }
  }

  for (
    const pattern of [
      /\bappid\s*=\s*["']?(\d{2,10})\b/gi,
      /["']appid["']\s*:\s*["']?(\d{2,10})\b/gi,
      /\bappid\s*:\s*["']?(\d{2,10})\b/gi,
      /\/app\/(\d{2,10})(?=[/?#"'&<\s]|$)/gi,
      /["'](\d{2,10})["']\s*:\s*\{[^}]{0,3000}\b(?:appid|name|subs|capsule)\b/gi,
    ]
  ) {
    for (const match of html.matchAll(pattern)) {
      addId(match[1]);
    }
  }

  for (const section of wishlistDataSections(html)) {
    for (
      const pattern of [
        /["']appid["']\s*:\s*["']?(\d{2,10})\b/gi,
        /["'](\d{2,10})["']\s*:\s*\{/gi,
      ]
    ) {
      for (const match of section.matchAll(pattern)) {
        addId(match[1]);
      }
    }
  }

  return [...ids];
}

function wishlistDataSections(html: string): string[] {
  const sections: string[] = [];
  for (const marker of ["g_rgWishlistData", "rgWishlistData"]) {
    let start = html.indexOf(marker);
    while (start >= 0) {
      const endScript = html.indexOf("</script>", start);
      const end = endScript >= 0 ? endScript : start + 250_000;
      sections.push(html.slice(start, Math.min(end, start + 250_000)));
      start = html.indexOf(marker, start + marker.length);
    }
  }
  return sections;
}

function extractSteamIdFromWishlistHtml(html: string): string | null {
  const patterns = [
    /\/wishlist\/profiles\/(\d{17})/i,
    /wishlistcategories[^0-9]{1,120}(\d{17})/i,
    /["']steamid["']\s*:\s*["'](\d{17})["']/i,
    /\bg_steamID\s*=\s*["'](\d{17})["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
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

function formatPriceLine(
  finalPriceKzt: number,
  originalPriceKzt: number,
): string {
  return `${formatKzt(finalPriceKzt)} (было ${formatKzt(originalPriceKzt)})`;
}

function formatKzt(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value) + "₸";
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
