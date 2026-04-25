import {
  assertCronSecret,
  getOptionalEnv,
  getRequiredEnv,
  handleFunctionError,
  jsonResponse,
} from "../_shared/env.ts";
import { sha256Hex } from "../_shared/checksum.ts";
import { fetchJsonWithTimeout, fetchTextWithTimeout } from "../_shared/http.ts";
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
const DEFAULT_MIN_DISCOUNT_PERCENT = 70;
const DEFAULT_MAX_PRICE_KZT = 3500;
const APPDETAILS_CONCURRENCY = 5;
const STEAM_HEADERS = {
  accept: "application/json, text/html;q=0.9, */*;q=0.1",
  "cache-control": "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LifeOSAlertBot/1.0 Chrome/124.0 Safari/537.36",
};

type FetchMode = "wishlistdata" | "html_appdetails_fallback";
type SteamDealKind = "free_claim" | "huge_discount" | "low_price";

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
  minDiscountPercent: number;
  maxPriceKzt: number;
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
  finalPrice: number | null;
  originalPrice: number | null;
  finalFormatted: string | null;
  originalFormatted: string | null;
}

interface SteamDealClassification {
  dealKind: SteamDealKind;
  finalPriceKzt: number | null;
  originalPriceKzt: number | null;
}

interface SteamAppDetailsResponse {
  [appId: string]: {
    success?: boolean;
    data?: unknown;
  };
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
    let result: BuildRowsResult;
    try {
      result = await buildRowsFromWishlistData(source.id, config);
    } catch (error) {
      errors.push(`wishlistdata: ${errorMessage(error)}`);
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
    const message = error instanceof Error ? error.message : String(error);
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
  const minDiscountPercent = optionalNumberEnv(
    "STEAM_MIN_DISCOUNT_PERCENT",
    DEFAULT_MIN_DISCOUNT_PERCENT,
  );
  const maxPriceKzt = optionalNumberEnv(
    "STEAM_MAX_PRICE_KZT",
    DEFAULT_MAX_PRICE_KZT,
  );

  return {
    steamId,
    vanity,
    country,
    locale,
    minDiscountPercent,
    maxPriceKzt,
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
  let processed = 0;
  let skipped = 0;

  for (const [appId, game] of Object.entries(wishlist)) {
    processed += 1;
    if (!isRecord(game)) {
      skipped += 1;
      continue;
    }

    const bestOffer = bestDiscountedSub(game);
    if (!bestOffer) {
      skipped += 1;
      continue;
    }

    const deal = classifySteamDeal(bestOffer, config);
    if (!deal) {
      skipped += 1;
      continue;
    }

    rows.push(
      await steamDiscountEventRow({
        sourceId,
        appId,
        name: stringValue(game.name) || `Steam app ${appId}`,
        offer: bestOffer,
        deal,
        nowIso,
        country: config.country,
        locale: config.locale,
        fetchMode: "wishlistdata",
        sourcePayload: {
          wishlist_game: game,
          selected_sub: bestOffer.raw,
        },
      }),
    );
  }

  return {
    fetchMode: "wishlistdata",
    rows,
    processed,
    skipped,
    cleanupExternalIds: new Set(rows.map((row) => row.external_id)),
    errors: [],
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
      "Steam wishlist page fallback did not expose any appids in HTML",
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
        appDetailsEventRow({
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
      finalPrice: numberValue(sub.discount_price) ??
        numberValue(sub.final_price) ??
        numberValue(sub.discounted_price) ??
        discountBlockFinalPrice(sub) ??
        numberValue(sub.price),
      originalPrice: numberValue(sub.original_price) ??
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

    return priceForSort(left.finalPrice) - priceForSort(right.finalPrice);
  });

  return discounted[0] || null;
}

async function appDetailsEventRow(params: {
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
    const appDetails = await fetchSteamAppDetails(appId, config);
    if (!appDetails.success || !isRecord(appDetails.data)) {
      return { appId, row: null, keepActive: false, error: null };
    }

    const offer = appDetailsDiscountOffer(appDetails.data);
    if (!offer) {
      return { appId, row: null, keepActive: false, error: null };
    }
    const deal = classifySteamDeal(offer, config);
    if (!deal) {
      return { appId, row: null, keepActive: false, error: null };
    }

    return {
      appId,
      row: await steamDiscountEventRow({
        sourceId,
        appId,
        name: stringValue(appDetails.data.name) || `Steam app ${appId}`,
        offer,
        deal,
        nowIso,
        country: config.country,
        locale: config.locale,
        fetchMode: "html_appdetails_fallback",
        sourcePayload: {
          appdetails: appDetails.data,
        },
      }),
      keepActive: false,
      error: null,
    };
  } catch (error) {
    return {
      appId,
      row: null,
      keepActive: true,
      error: `appdetails ${appId}: ${errorMessage(error)}`,
    };
  }
}

async function fetchSteamAppDetails(
  appId: string,
  config: SteamConfig,
): Promise<{ success: boolean; data?: unknown }> {
  const params = new URLSearchParams({
    appids: appId,
    cc: config.country,
    l: config.locale,
    filters: "price_overview,basic",
  });
  const payload = await fetchJsonWithTimeout<SteamAppDetailsResponse>(
    `https://store.steampowered.com/api/appdetails?${params.toString()}`,
    {
      label: `Steam appdetails ${appId}`,
      headers: STEAM_HEADERS,
    },
  );
  const details = payload[appId];
  return {
    success: details?.success === true,
    data: details?.data,
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

function appDetailsDiscountOffer(
  appDetails: Record<string, unknown>,
): DiscountedSteamOffer | null {
  const priceOverview = recordValue(appDetails.price_overview);
  if (!priceOverview) {
    return null;
  }

  const discountPct = numberValue(priceOverview.discount_percent) || 0;
  if (discountPct <= 0) {
    return null;
  }

  return {
    raw: priceOverview,
    discountPct,
    finalPrice: numberValue(priceOverview.final),
    originalPrice: numberValue(priceOverview.initial),
    finalFormatted: stringValue(priceOverview.final_formatted),
    originalFormatted: stringValue(priceOverview.initial_formatted),
  };
}

async function steamDiscountEventRow(params: {
  sourceId: string;
  appId: string;
  name: string;
  offer: DiscountedSteamOffer;
  deal: SteamDealClassification;
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
    offer,
    deal,
    nowIso,
    country,
    locale,
    fetchMode,
    sourcePayload,
  } = params;
  const storeUrl = `https://store.steampowered.com/app/${
    encodeURIComponent(appId)
  }`;
  const priceLine = steamPriceLine(offer);
  const checksum = await sha256Hex([
    SOURCE_KIND,
    appId,
    offer.discountPct,
    offer.finalPrice ?? "",
  ].join("|"));

  return {
    source_id: sourceId,
    external_id: appId,
    title: `🎮 Steam скидка: ${name} — -${offer.discountPct}%`,
    description: [
      `Игра: ${name}`,
      `Скидка: -${offer.discountPct}%`,
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
      fetch_mode: fetchMode,
      deal_kind: deal.dealKind,
      store: "steam",
      app_id: appId,
      name,
      discount_percent: offer.discountPct,
      final_price_kzt: deal.finalPriceKzt,
      original_price_kzt: deal.originalPriceKzt,
      country,
      locale,
      store_url: storeUrl,
      should_create_google_task: deal.dealKind === "free_claim",
      should_push_telegram: true,
      ...sourcePayload,
    },
    checksum,
    status: "active",
  };
}

function classifySteamDeal(
  offer: DiscountedSteamOffer,
  config: SteamConfig,
): SteamDealClassification | null {
  const finalPriceKzt = kztFromSteamPrice(offer.finalPrice);
  const originalPriceKzt = kztFromSteamPrice(offer.originalPrice);

  if (finalPriceKzt === 0 || offer.discountPct === 100) {
    return {
      dealKind: "free_claim",
      finalPriceKzt,
      originalPriceKzt,
    };
  }

  if (offer.discountPct >= config.minDiscountPercent) {
    return {
      dealKind: "huge_discount",
      finalPriceKzt,
      originalPriceKzt,
    };
  }

  if (finalPriceKzt !== null && finalPriceKzt <= config.maxPriceKzt) {
    return {
      dealKind: "low_price",
      finalPriceKzt,
      originalPriceKzt,
    };
  }

  return null;
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

function steamPriceLine(offer: DiscountedSteamOffer): string | null {
  const finalText = offer.finalFormatted || formatKztMinor(offer.finalPrice);
  const originalText = offer.originalFormatted ||
    formatKztMinor(offer.originalPrice);

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

function optionalNumberEnv(name: string, fallback: number): number {
  const raw = getOptionalEnv(name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be zero or a positive number`);
  }
  return value;
}

function kztFromSteamPrice(value: number | null): number | null {
  return value === null ? null : value / 100;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
