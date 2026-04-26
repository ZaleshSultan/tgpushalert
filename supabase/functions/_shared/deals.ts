import type { ExternalEventRow } from "./supabase.ts";

export type DealKind =
  | "free"
  | "huge_discount"
  | "discount"
  | "cheap"
  | "ignore";

export type DealPriority = "high" | "normal" | "low" | "skip";

export interface DealSnapshot {
  name: string;
  dealKind: DealKind;
  finalPriceKzt: number;
  originalPriceKzt: number;
  discountPercent: number;
  storeUrl: string;
  storeLabel: string;
}

export interface ClassifyDealInput {
  finalPriceKzt: number;
  discountPercent: number;
}

export function classifyDeal(input: ClassifyDealInput): DealKind {
  if (input.finalPriceKzt === 0) {
    return "free";
  }
  if (input.discountPercent >= 70) {
    return "huge_discount";
  }
  if (input.discountPercent >= 30) {
    return "discount";
  }
  if (input.finalPriceKzt <= 3500) {
    return "cheap";
  }
  return "ignore";
}

export function isGameDealEvent(
  event: Pick<ExternalEventRow, "sources">,
): boolean {
  return event.sources?.kind === "steam_wishlist" ||
    event.sources?.kind === "epic_games";
}

export function dealAlertType(kind: DealKind): string | null {
  switch (kind) {
    case "free":
      return "deal_free";
    case "huge_discount":
      return "deal_huge_discount";
    case "discount":
      return "deal_discount";
    case "cheap":
      return "deal_cheap";
    default:
      return null;
  }
}

export function dealPriority(kind: DealKind): DealPriority {
  switch (kind) {
    case "free":
    case "huge_discount":
      return "high";
    case "discount":
      return "normal";
    case "cheap":
      return "low";
    default:
      return "skip";
  }
}

export function dealSortWeight(kind: DealKind): number {
  switch (kind) {
    case "free":
      return 0;
    case "huge_discount":
      return 1;
    case "discount":
      return 2;
    case "cheap":
      return 3;
    default:
      return 4;
  }
}

export function dealKindLabel(kind: DealKind): string {
  switch (kind) {
    case "free":
      return "Бесплатно";
    case "huge_discount":
      return "Большая скидка";
    case "discount":
      return "Скидка";
    case "cheap":
      return "Дешево";
    default:
      return "Игнор";
  }
}

export function getDealSnapshot(event: ExternalEventRow): DealSnapshot | null {
  if (!isGameDealEvent(event)) {
    return null;
  }

  const raw = event.raw_payload_json || {};
  const finalPriceKzt = readNumber(raw.final_price_kzt) ?? 0;
  const originalPriceKzt = readNumber(raw.original_price_kzt) ?? finalPriceKzt;
  const discountPercent = readNumber(raw.discount_percent) ??
    inferDiscountPercent(finalPriceKzt, originalPriceKzt);
  const storeUrl = readString(raw.store_url) || defaultStoreUrl(event);
  const name = readString(raw.name) || readString(raw.title) ||
    stripDealTitle(event.title);
  const dealKind = normalizeDealKind(readString(raw.deal_kind)) ||
    classifyDeal({
      finalPriceKzt,
      discountPercent,
    });

  return {
    name,
    dealKind,
    finalPriceKzt,
    originalPriceKzt,
    discountPercent,
    storeUrl,
    storeLabel: event.sources?.kind === "steam_wishlist"
      ? "Steam"
      : "Epic Games",
  };
}

export function formatKztAmount(value: number): string {
  return `${formatDealNumber(value)}₸`;
}

export function formatDiscountPercent(value: number): string {
  return `${formatDealNumber(value)}%`;
}

function inferDiscountPercent(
  finalPriceKzt: number,
  originalPriceKzt: number,
): number {
  if (originalPriceKzt <= 0) {
    return finalPriceKzt === 0 ? 100 : 0;
  }

  const ratio = (1 - finalPriceKzt / originalPriceKzt) * 100;
  return Math.max(0, Math.round(ratio));
}

function defaultStoreUrl(
  event: Pick<ExternalEventRow, "external_id" | "sources">,
): string {
  if (event.sources?.kind === "steam_wishlist") {
    return `https://store.steampowered.com/app/${
      encodeURIComponent(event.external_id)
    }`;
  }

  return "https://store.epicgames.com/";
}

function normalizeDealKind(value: string | null): DealKind | null {
  if (
    value === "free" ||
    value === "huge_discount" ||
    value === "discount" ||
    value === "cheap" ||
    value === "ignore"
  ) {
    return value;
  }
  if (value === "free_claim") {
    return "free";
  }
  if (value === "low_price") {
    return "cheap";
  }
  return null;
}

function stripDealTitle(title: string): string {
  return title
    .replace(/^🎮\s*Steam скидка:\s*/u, "")
    .replace(/^🎁\s*Бесплатно в Epic Games:\s*/u, "")
    .replace(/\s+[-—]\s+-?\d+(?:[.,]\d+)?%$/u, "")
    .trim() || title;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number(value.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDealNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}
