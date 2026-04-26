import { fetchJsonWithTimeout, fetchTextWithTimeout } from "./http.ts";

export interface SteamStoreConfig {
  country: string;
  locale: string;
  headers?: HeadersInit;
}

export interface SteamPriceCandidate {
  discountPercent?: number | null;
  finalPriceMinor?: number | null;
  originalPriceMinor?: number | null;
  finalFormatted?: string | null;
  originalFormatted?: string | null;
  raw?: Record<string, unknown>;
}

export interface SteamResolvedDeal {
  source: "candidate" | "appdetails" | "html";
  name: string | null;
  discountPercent: number;
  finalPriceMinor: number;
  originalPriceMinor: number;
  finalPriceKzt: number;
  originalPriceKzt: number;
  finalFormatted: string | null;
  originalFormatted: string | null;
  raw: Record<string, unknown>;
  storeUrl: string;
}

interface SteamAppDetailsResponse {
  [appId: string]: {
    success?: boolean;
    data?: unknown;
  };
}

export async function resolveSteamDeal(
  appId: string,
  config: SteamStoreConfig,
  candidate?: SteamPriceCandidate,
): Promise<SteamResolvedDeal | null> {
  const completeCandidate = normalizeCandidate(appId, candidate);
  if (completeCandidate) {
    return completeCandidate;
  }

  let appDetailsError: unknown = null;
  try {
    const fromAppDetails = await fetchSteamDealFromAppDetails(appId, config);
    if (fromAppDetails) {
      return fromAppDetails;
    }
  } catch (error) {
    appDetailsError = error;
  }

  const fromHtml = await fetchSteamDealFromHtml(appId, config);
  if (fromHtml) {
    return fromHtml;
  }

  if (appDetailsError) {
    throw appDetailsError;
  }

  return null;
}

export function steamStoreUrl(appId: string): string {
  return `https://store.steampowered.com/app/${encodeURIComponent(appId)}`;
}

async function fetchSteamDealFromAppDetails(
  appId: string,
  config: SteamStoreConfig,
): Promise<SteamResolvedDeal | null> {
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
      headers: config.headers,
    },
  );
  const details = payload[appId];
  if (!details?.success || !isRecord(details.data)) {
    return null;
  }

  const data = details.data;
  const priceOverview = recordValue(data.price_overview);
  if (!priceOverview) {
    return null;
  }

  const completed = completePriceFields({
    discountPercent: numberValue(priceOverview.discount_percent),
    finalPriceMinor: numberValue(priceOverview.final),
    originalPriceMinor: numberValue(priceOverview.initial),
  });
  if (!completed || completed.discountPercent <= 0) {
    return null;
  }

  return {
    source: "appdetails",
    name: stringValue(data.name),
    discountPercent: completed.discountPercent,
    finalPriceMinor: completed.finalPriceMinor,
    originalPriceMinor: completed.originalPriceMinor,
    finalPriceKzt: majorFromMinor(completed.finalPriceMinor),
    originalPriceKzt: majorFromMinor(completed.originalPriceMinor),
    finalFormatted: stringValue(priceOverview.final_formatted),
    originalFormatted: stringValue(priceOverview.initial_formatted),
    raw: priceOverview,
    storeUrl: steamStoreUrl(appId),
  };
}

async function fetchSteamDealFromHtml(
  appId: string,
  config: SteamStoreConfig,
): Promise<SteamResolvedDeal | null> {
  const params = new URLSearchParams({
    cc: config.country,
    l: config.locale,
  });
  const html = await fetchTextWithTimeout(
    `${steamStoreUrl(appId)}/?${params.toString()}`,
    {
      label: `Steam store page ${appId}`,
      headers: config.headers,
    },
  );

  const discountPercent = parseDiscountPercent(html);
  if (discountPercent === null || discountPercent <= 0) {
    return null;
  }

  const originalPriceMinor = matchMinorPrice(html, [
    /\bdata-discounted-original-price=["']?(\d+)/i,
    /\bdata-price-initial=["']?(\d+)/i,
    /\bdata-price-original=["']?(\d+)/i,
  ]);
  const finalPriceMinor = matchMinorPrice(html, [
    /\bdata-price-final=["']?(\d+)/i,
  ]);
  const originalText = matchText(html, [
    /discount_original_price[^>]*>\s*([^<]+?)\s*</i,
    /bundle_original_price[^>]*>\s*([^<]+?)\s*</i,
  ]);
  const finalText = matchText(html, [
    /discount_final_price[^>]*>\s*([^<]+?)\s*</i,
    /game_purchase_price\s+price[^>]*>\s*([^<]+?)\s*</i,
  ]);
  const completed = completePriceFields({
    discountPercent,
    finalPriceMinor: finalPriceMinor ?? minorFromMajorText(finalText),
    originalPriceMinor: originalPriceMinor ?? minorFromMajorText(originalText),
  });
  if (!completed) {
    return null;
  }

  return {
    source: "html",
    name: parseSteamAppName(html),
    discountPercent: completed.discountPercent,
    finalPriceMinor: completed.finalPriceMinor,
    originalPriceMinor: completed.originalPriceMinor,
    finalPriceKzt: majorFromMinor(completed.finalPriceMinor),
    originalPriceKzt: majorFromMinor(completed.originalPriceMinor),
    finalFormatted: normalizeMoneyText(finalText),
    originalFormatted: normalizeMoneyText(originalText),
    raw: {
      discount_percent: completed.discountPercent,
      final_price_minor: completed.finalPriceMinor,
      original_price_minor: completed.originalPriceMinor,
    },
    storeUrl: steamStoreUrl(appId),
  };
}

function normalizeCandidate(
  appId: string,
  candidate?: SteamPriceCandidate,
): SteamResolvedDeal | null {
  if (!candidate) {
    return null;
  }

  const completed = completePriceFields({
    discountPercent: candidate.discountPercent ?? null,
    finalPriceMinor: candidate.finalPriceMinor ?? null,
    originalPriceMinor: candidate.originalPriceMinor ?? null,
  });
  if (!completed || completed.discountPercent <= 0) {
    return null;
  }

  return {
    source: "candidate",
    name: null,
    discountPercent: completed.discountPercent,
    finalPriceMinor: completed.finalPriceMinor,
    originalPriceMinor: completed.originalPriceMinor,
    finalPriceKzt: majorFromMinor(completed.finalPriceMinor),
    originalPriceKzt: majorFromMinor(completed.originalPriceMinor),
    finalFormatted: candidate.finalFormatted ?? null,
    originalFormatted: candidate.originalFormatted ?? null,
    raw: candidate.raw || {},
    storeUrl: steamStoreUrl(appId),
  };
}

function completePriceFields(input: {
  discountPercent: number | null;
  finalPriceMinor: number | null;
  originalPriceMinor: number | null;
}): {
  discountPercent: number;
  finalPriceMinor: number;
  originalPriceMinor: number;
} | null {
  const discountPercent = input.discountPercent;
  let finalPriceMinor = input.finalPriceMinor;
  let originalPriceMinor = input.originalPriceMinor;

  if (
    finalPriceMinor === null &&
    originalPriceMinor !== null &&
    discountPercent !== null &&
    discountPercent >= 0 &&
    discountPercent < 100
  ) {
    finalPriceMinor = Math.round(
      originalPriceMinor * (100 - discountPercent) / 100,
    );
  }

  if (
    originalPriceMinor === null &&
    finalPriceMinor !== null &&
    discountPercent !== null &&
    discountPercent >= 0 &&
    discountPercent < 100
  ) {
    originalPriceMinor = Math.round(
      finalPriceMinor / (1 - discountPercent / 100),
    );
  }

  if (
    finalPriceMinor === 0 &&
    discountPercent === 100 &&
    originalPriceMinor === null
  ) {
    originalPriceMinor = 0;
  }

  if (
    discountPercent === null ||
    finalPriceMinor === null ||
    originalPriceMinor === null
  ) {
    return null;
  }

  return {
    discountPercent,
    finalPriceMinor,
    originalPriceMinor,
  };
}

function parseSteamAppName(html: string): string | null {
  const match = html.match(/id=["']appHubAppName["'][^>]*>\s*([^<]+?)\s*</i);
  if (!match) {
    return null;
  }

  return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim() || null;
}

function parseDiscountPercent(html: string): number | null {
  const match = html.match(/discount_pct[^>]*>\s*-?(\d+)\s*%\s*</i);
  return match ? numberValue(match[1]) : null;
}

function minorFromMajorText(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeMoneyText(value);
  if (!normalized) {
    return null;
  }
  if (/^(free|бесплатно)$/i.test(normalized)) {
    return 0;
  }

  const compact = normalized.replace(/\s+/g, "").replace("₸", "")
    .replace(",", ".");
  const parsed = Number(compact);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round(parsed * 100);
}

function majorFromMinor(value: number): number {
  return value / 100;
}

function matchMinorPrice(
  text: string,
  patterns: RegExp[],
): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return numberValue(match[1]);
    }
  }
  return null;
}

function matchText(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim() || null;
    }
  }
  return null;
}

function normalizeMoneyText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, " ")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
