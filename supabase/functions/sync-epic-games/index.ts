import {
  assertCronSecret,
  getOptionalEnv,
  handleFunctionError,
  jsonResponse,
} from "../_shared/env.ts";
import { sha256Hex } from "../_shared/checksum.ts";
import { classifyDeal } from "../_shared/deals.ts";
import { fetchJsonWithTimeout } from "../_shared/http.ts";
import {
  ensureSource,
  type ExternalEventUpsert,
  finishSyncRun,
  markMissingEvents,
  startSyncRun,
  upsertExternalEvents,
} from "../_shared/supabase.ts";

const SOURCE_KIND = "epic_games";
const SOURCE_NAME = "Epic Games Store";
const DEFAULT_COUNTRY = "KZ";
const DEFAULT_LOCALE = "ru";
const DISPLAY_TIMEZONE = "Asia/Almaty";

interface EpicApiResponse {
  data?: {
    Catalog?: {
      searchStore?: {
        elements?: unknown[];
      };
    };
  };
}

interface ActiveOffer {
  raw: Record<string, unknown>;
  startDate: string;
  endDate: string;
}

interface EpicPriceInfo {
  raw: Record<string, unknown>;
  discountPrice: number;
  originalPrice: number;
  currencyCode: string;
  decimals: number;
  formattedOriginal: string | null;
  formattedDiscount: string | null;
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    assertCronSecret(req);
    const result = await syncEpicGames();
    return jsonResponse(result, result.success ? 200 : 500);
  } catch (error) {
    return handleFunctionError(error);
  }
});

async function syncEpicGames(): Promise<SyncResponse> {
  let runId: string | null = null;
  let sourceId: string | undefined;
  let processed = 0;
  let upserted = 0;
  let skipped = 0;

  try {
    const source = await ensureSource(SOURCE_KIND, SOURCE_NAME);
    sourceId = source.id;

    if (!source.is_enabled) {
      console.log("[sync-epic-games] source disabled");
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

    const country = getOptionalEnv("EPIC_COUNTRY", DEFAULT_COUNTRY).trim()
      .toUpperCase() || DEFAULT_COUNTRY;
    const locale = getOptionalEnv("EPIC_LOCALE", DEFAULT_LOCALE).trim() ||
      DEFAULT_LOCALE;
    console.log("[sync-epic-games] started", {
      sourceId: source.id,
      country,
      locale,
    });
    const payload = await fetchJsonWithTimeout<EpicApiResponse>(
      epicPromotionsUrl(country, locale),
      {
        label: "Epic Games promotions fetch",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
          "user-agent": "Life OS Alert Bot Epic Games Sync",
        },
      },
    );

    const elements = payload.data?.Catalog?.searchStore?.elements;
    if (!Array.isArray(elements)) {
      throw new Error(
        "Epic Games response did not include data.Catalog.searchStore.elements",
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const rows: ExternalEventUpsert[] = [];

    for (const element of elements) {
      processed += 1;
      if (!isRecord(element)) {
        skipped += 1;
        continue;
      }

      const row = await epicGameToEventRow({
        sourceId: source.id,
        game: element,
        now,
        nowIso,
        country,
        locale,
      });
      if (!row) {
        skipped += 1;
        continue;
      }
      rows.push(row);
    }

    const resultRows = await upsertExternalEvents(rows);
    upserted = resultRows.length;
    const missing = await markMissingEvents(
      source.id,
      new Set(rows.map((row) => row.external_id)),
    );

    console.log("[sync-epic-games] completed", {
      processed,
      upserted,
      skipped,
      missing,
    });

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
    console.error("[sync-epic-games] failed", {
      message,
      processed,
      upserted,
      skipped,
    });
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

function epicPromotionsUrl(country: string, locale: string): string {
  const params = new URLSearchParams({
    locale,
    country,
    allowCountries: country,
  });
  return `https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?${params.toString()}`;
}

async function epicGameToEventRow(params: {
  sourceId: string;
  game: Record<string, unknown>;
  now: Date;
  nowIso: string;
  country: string;
  locale: string;
}): Promise<ExternalEventUpsert | null> {
  const { sourceId, game, now, nowIso, country, locale } = params;
  if (!isCatalogGame(game)) {
    return null;
  }

  const activeOffer = activePromotionalOffer(game, now);
  if (!activeOffer) {
    return null;
  }

  const price = epicPriceInfo(game);
  if (!price || price.discountPrice !== 0 || price.originalPrice <= 0) {
    return null;
  }

  const finalPriceKzt = price.discountPrice / 10 ** price.decimals;
  const originalPriceKzt = price.originalPrice / 10 ** price.decimals;
  const discountPercent = Math.max(
    0,
    Math.round((1 - price.discountPrice / price.originalPrice) * 100),
  );
  const dealKind = classifyDeal({
    finalPriceKzt,
    discountPercent,
  });
  if (dealKind !== "free") {
    return null;
  }

  const externalId = stableExternalId(game);
  if (!externalId) {
    return null;
  }

  const title = stringValue(game.title) || "Безымянная раздача Epic Games";
  const pageSlug = epicPageSlug(game);
  const storeUrl = epicStoreUrl(pageSlug, productSlug(game), locale);
  const checksum = await sha256Hex([
    SOURCE_KIND,
    externalId,
    activeOffer.endDate,
    discountPercent,
    originalPriceKzt,
  ].join("|"));

  return {
    source_id: sourceId,
    external_id: externalId,
    title,
    description: [
      `Игра: ${title}`,
      `Бесплатно до: ${formatAlmatyDateTime(activeOffer.endDate)}`,
      `Цена: ${price.formattedDiscount || formatMinorPrice(0, price)}${
        price.formattedOriginal ? ` (было ${price.formattedOriginal})` : ""
      }`,
      storeUrl ? `Ссылка: ${storeUrl}` : null,
    ].filter(Boolean).join("\n"),
    location: null,
    starts_at: activeOffer.startDate,
    ends_at: activeOffer.endDate,
    due_at: activeOffer.endDate,
    due_date: null,
    has_explicit_time: true,
    remind_at: nowIso,
    raw_payload_json: {
      source_kind: SOURCE_KIND,
      deal_kind: dealKind,
      store: "epic_games",
      epic_id: stringValue(game.id),
      namespace: stringValue(game.namespace),
      name: title,
      title,
      offer_type: stringValue(game.offerType),
      page_slug: pageSlug,
      product_slug: productSlug(game),
      country,
      locale,
      store_url: storeUrl,
      final_price_kzt: finalPriceKzt,
      original_price_kzt: originalPriceKzt,
      discount_percent: discountPercent,
      should_create_google_task: true,
      should_push_telegram: true,
      price: price.raw,
      active_offer: activeOffer.raw,
    },
    checksum,
    status: "active",
  };
}

function isCatalogGame(game: Record<string, unknown>): boolean {
  if (stringValue(game.status) !== "ACTIVE") {
    return false;
  }
  if (game.isCodeRedemptionOnly === true) {
    return false;
  }

  const offerType = stringValue(game.offerType);
  if (offerType && offerType !== "BASE_GAME") {
    return false;
  }

  const categoryPaths = categoryPathSet(game);
  if (!hasGameCategory(categoryPaths)) {
    return false;
  }

  return ![...categoryPaths].some((path) =>
    path.includes("addon") || path.includes("demo") ||
    path.includes("dlc") || path.includes("mod")
  );
}

function activePromotionalOffer(
  game: Record<string, unknown>,
  now: Date,
): ActiveOffer | null {
  const promotions = recordValue(game.promotions);
  const groups = Array.isArray(promotions?.promotionalOffers)
    ? promotions.promotionalOffers
    : [];
  const active: ActiveOffer[] = [];

  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.promotionalOffers)) {
      continue;
    }

    for (const offer of group.promotionalOffers) {
      if (!isRecord(offer)) {
        continue;
      }

      const startDate = isoDateString(offer.startDate);
      const endDate = isoDateString(offer.endDate);
      if (!startDate || !endDate) {
        continue;
      }

      const start = new Date(startDate);
      const end = new Date(endDate);
      if (now >= start && now < end) {
        active.push({ raw: offer, startDate, endDate });
      }
    }
  }

  active.sort((left, right) =>
    new Date(left.endDate).getTime() - new Date(right.endDate).getTime()
  );
  return active[0] || null;
}

function epicPriceInfo(game: Record<string, unknown>): EpicPriceInfo | null {
  const price = recordValue(game.price);
  const totalPrice = recordValue(price?.totalPrice);
  if (!totalPrice) {
    return null;
  }

  const discountPrice = numberValue(totalPrice.discountPrice);
  const originalPrice = numberValue(totalPrice.originalPrice);
  if (discountPrice === null || originalPrice === null) {
    return null;
  }

  const currencyInfo = recordValue(totalPrice.currencyInfo);
  const decimals = numberValue(currencyInfo?.decimals) ?? 2;
  const fmtPrice = recordValue(totalPrice.fmtPrice);
  const currencyCode = stringValue(totalPrice.currencyCode) || "KZT";

  return {
    raw: totalPrice,
    discountPrice,
    originalPrice,
    currencyCode,
    decimals,
    formattedOriginal: epicFormattedPrice(
      fmtPrice?.originalPrice,
      originalPrice,
      { currencyCode, decimals },
    ),
    formattedDiscount: epicFormattedPrice(
      fmtPrice?.discountPrice,
      discountPrice,
      { currencyCode, decimals },
    ),
  };
}

function stableExternalId(game: Record<string, unknown>): string | null {
  return stringValue(game.id) || productSlug(game) || epicPageSlug(game) ||
    stringValue(game.urlSlug);
}

function epicPageSlug(game: Record<string, unknown>): string | null {
  const catalogNs = recordValue(game.catalogNs);
  const candidates = [
    ...(Array.isArray(game.offerMappings) ? game.offerMappings : []),
    ...(Array.isArray(catalogNs?.mappings) ? catalogNs.mappings : []),
  ];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const slug = stringValue(candidate.pageSlug);
    if (slug) {
      return slug;
    }
  }

  return null;
}

function productSlug(game: Record<string, unknown>): string | null {
  const direct = stringValue(game.productSlug);
  if (direct) {
    return direct;
  }

  const attributes = Array.isArray(game.customAttributes)
    ? game.customAttributes
    : [];
  for (const attribute of attributes) {
    if (!isRecord(attribute)) {
      continue;
    }
    if (stringValue(attribute.key) === "com.epicgames.app.productSlug") {
      return stringValue(attribute.value);
    }
  }
  return null;
}

function epicStoreUrl(
  pageSlug: string | null,
  rawProductSlug: string | null,
  locale: string,
): string | null {
  const slug = pageSlug || normalizeProductSlug(rawProductSlug);
  if (!slug) {
    return null;
  }
  return `https://store.epicgames.com/${encodeURIComponent(locale)}/p/${
    encodeURIComponent(slug)
  }`;
}

function normalizeProductSlug(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const [slug] = value.split("/");
  return slug || null;
}

function categoryPathSet(game: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  const categories = Array.isArray(game.categories) ? game.categories : [];
  for (const category of categories) {
    if (!isRecord(category)) {
      continue;
    }
    const path = stringValue(category.path);
    if (path) {
      paths.add(path.toLowerCase());
    }
  }
  return paths;
}

function hasGameCategory(paths: Set<string>): boolean {
  for (const path of paths) {
    if (path === "games" || path.startsWith("games/")) {
      return true;
    }
  }
  return false;
}

function isoDateString(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatAlmatyDateTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: DISPLAY_TIMEZONE,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso)).replace(" в ", ", ");
}

function formatMinorPrice(
  amount: number,
  price: Pick<EpicPriceInfo, "currencyCode" | "decimals">,
): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: price.currencyCode,
  }).format(amount / 10 ** price.decimals);
}

function epicFormattedPrice(
  formatted: unknown,
  amount: number,
  price: Pick<EpicPriceInfo, "currencyCode" | "decimals">,
): string {
  const text = stringValue(formatted);
  if (text && text !== "0") {
    return text;
  }
  return formatMinorPrice(amount, price);
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
