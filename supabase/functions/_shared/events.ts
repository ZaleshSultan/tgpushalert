import type { ExternalEventRow } from "./supabase.ts";
import type { InlineKeyboardMarkup } from "./telegram.ts";
import { escapeHtml } from "./telegram.ts";
import { eventTimeIso, formatDateTime } from "./time.ts";

export function chooseAlertType(
  event: ExternalEventRow,
  now = new Date(),
): string | null {
  const iso = eventTimeIso(event);
  if (!iso) {
    return null;
  }

  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60000);
  if (minutes < -120) {
    return null;
  }
  if (minutes <= 0) {
    return "overdue";
  }
  if (minutes <= 10) {
    return "due_10m";
  }
  if (minutes <= 60) {
    return "due_1h";
  }
  if (minutes <= 24 * 60) {
    return "due_24h";
  }
  return null;
}

export function formatAlertMessage(
  event: ExternalEventRow,
  timeZone: string,
): string {
  if (isGameDealEvent(event)) {
    return formatGameDealAlertMessage(event, timeZone);
  }

  const titleParts = splitEventTitle(event.title);
  const alertKind = resolveAlertKind(event);
  const when = formatAlertWhen(event, alertKind.iso, timeZone);
  const description = cleanDescription(event.description, 150);

  const lines = [
    `${alertKind.emoji} <b>${alertKind.label}: ${
      escapeHtml(titleParts.subject)
    }</b>`,
    `📌 <b>Задание/Событие:</b> ${escapeHtml(titleParts.name)}`,
    when ? `⏰ <b>${alertKind.timeLabel}:</b> ${escapeHtml(when)}` : null,
    description ? `📝 <i>${escapeHtml(description)}</i>` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

export function formatTodayLine(
  event: ExternalEventRow,
  timeZone: string,
): string {
  const iso = eventTimeIso(event);
  const source = event.sources?.name || "Life OS";
  const when = formatWhen(event, timeZone, iso);
  return `- ${escapeHtml(when)} | ${escapeHtml(source)} | ${
    escapeHtml(event.title)
  }`;
}

export function eventKeyboard(event: ExternalEventRow): InlineKeyboardMarkup {
  const eventId = event.id;
  if (isGameDealEvent(event)) {
    return {
      inline_keyboard: [
        [{
          text: "✅ купил/забрал",
          callback_data: `game_deal_done_${eventId}`,
        }],
        [{
          text: "⏳ чуть позже",
          callback_data: `game_deal_later_${eventId}`,
        }],
        [{
          text: "💸 денег нет",
          callback_data: `game_deal_no_money_${eventId}`,
        }],
        [{
          text: "🙅 не интересно",
          callback_data: `game_deal_not_interested_${eventId}`,
        }],
      ],
    };
  }

  return {
    inline_keyboard: [
      [{ text: "✅ done", callback_data: `event_done_${eventId}` }],
      [{ text: "⏳ mute 45m", callback_data: `event_mute_${eventId}` }],
      [{ text: "📅 tomorrow", callback_data: `event_tomorrow_${eventId}` }],
    ],
  };
}

function isGameDealEvent(event: ExternalEventRow): boolean {
  return event.sources?.kind === "steam_wishlist" ||
    event.sources?.kind === "epic_games";
}

function formatGameDealAlertMessage(
  event: ExternalEventRow,
  timeZone: string,
): string {
  return event.sources?.kind === "steam_wishlist"
    ? formatSteamDealAlertMessage(event)
    : formatEpicDealAlertMessage(event, timeZone);
}

function formatSteamDealAlertMessage(event: ExternalEventRow): string {
  const name = payloadString(event, "name") || stripSteamDealTitle(event.title);
  const finalPriceKzt = payloadNumber(event, "final_price_kzt");
  const originalPriceKzt = payloadNumber(event, "original_price_kzt");
  const discountPercent = payloadNumber(event, "discount_percent");
  const storeUrl = payloadString(event, "store_url") ||
    `https://store.steampowered.com/app/${
      encodeURIComponent(event.external_id)
    }`;

  return [
    `🎮 <b>Steam скидка: ${escapeHtml(name)}</b>`,
    `💸 <b>Цена:</b> ${escapeHtml(formatKztAmount(finalPriceKzt))}`,
    `📉 <b>Скидка:</b> ${escapeHtml(formatDiscount(discountPercent))}`,
    `🏷 <b>Было:</b> ${escapeHtml(formatKztAmount(originalPriceKzt))}`,
    `🔗 ${escapeHtml(storeUrl)}`,
  ].join("\n");
}

function formatEpicDealAlertMessage(
  event: ExternalEventRow,
  timeZone: string,
): string {
  const name = payloadString(event, "name") ||
    payloadString(event, "title") ||
    stripEpicDealTitle(event.title);
  const storeUrl = payloadString(event, "store_url");
  const dueAt = event.due_at ? formatRuDateTime(event.due_at, timeZone) : null;

  return [
    `🎁 <b>Забрать бесплатно: ${escapeHtml(name)}</b>`,
    `🛒 <b>Магазин:</b> ${escapeHtml("Epic Games")}`,
    `⏳ <b>До:</b> ${escapeHtml(dueAt || "неизвестно")}`,
    storeUrl ? `🔗 ${escapeHtml(storeUrl)}` : null,
  ].filter(Boolean).join("\n");
}

function payloadString(event: ExternalEventRow, key: string): string | null {
  const value = event.raw_payload_json?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function payloadNumber(event: ExternalEventRow, key: string): number | null {
  const value = event.raw_payload_json?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stripSteamDealTitle(title: string): string {
  return title.replace(/^🎮\s*Steam скидка:\s*/u, "")
    .replace(/\s+—\s+-\d+(?:[.,]\d+)?%$/u, "")
    .trim() || title;
}

function stripEpicDealTitle(title: string): string {
  return title.replace(/^🎁\s*Бесплатно в Epic Games:\s*/u, "").trim() ||
    title;
}

function formatKztAmount(value: number | null): string {
  if (value === null) {
    return "неизвестно";
  }
  return `${formatDealNumber(value)} ₸`;
}

function formatDiscount(value: number | null): string {
  return value === null ? "неизвестно" : `-${formatDealNumber(value)}%`;
}

function formatDealNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function formatWhen(
  event: ExternalEventRow,
  timeZone: string,
  fallbackIso: string | null,
): string {
  if (isDateOnlyGoogleTask(event) && event.due_date) {
    return `${formatRuDateOnly(event.due_date, timeZone)} (без времени)`;
  }
  return fallbackIso ? formatDateTime(fallbackIso, timeZone) : "no time";
}

function isDateOnlyGoogleTask(event: ExternalEventRow): boolean {
  return event.sources?.kind === "google_tasks" &&
    event.has_explicit_time === false;
}

function splitEventTitle(title: string): { subject: string; name: string } {
  const separatorIndex = title.indexOf(":");
  if (separatorIndex < 0) {
    return {
      subject: "Общее",
      name: title.trim() || "Без названия",
    };
  }

  const subject = title.slice(0, separatorIndex).trim() || "Общее";
  const name = title.slice(separatorIndex + 1).trim() || title.trim() ||
    "Без названия";
  return { subject, name };
}

function resolveAlertKind(event: ExternalEventRow): {
  emoji: string;
  label: string;
  timeLabel: string;
  iso: string | null;
} {
  if (event.due_at) {
    return {
      emoji: "🔴",
      label: "ДЕДЛАЙН",
      timeLabel: "Срок",
      iso: event.due_at,
    };
  }

  if (isDateOnlyGoogleTask(event) && event.due_date) {
    return {
      emoji: "🔴",
      label: "ДЕДЛАЙН",
      timeLabel: "Срок",
      iso: null,
    };
  }

  if (event.starts_at) {
    return {
      emoji: "📅",
      label: "РАСПИСАНИЕ",
      timeLabel: "Начало",
      iso: event.starts_at,
    };
  }

  return {
    emoji: "⏰",
    label: "НАПОМИНАНИЕ",
    timeLabel: "Время",
    iso: eventTimeIso(event),
  };
}

function formatAlertWhen(
  event: ExternalEventRow,
  iso: string | null,
  timeZone: string,
): string | null {
  if (isDateOnlyGoogleTask(event) && event.due_date) {
    return `${formatRuDateOnly(event.due_date, timeZone)} (без времени)`;
  }

  return iso ? formatRuDateTime(iso, timeZone) : null;
}

function formatRuDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso)).replace(" в ", ", ");
}

function formatRuDateOnly(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

function cleanDescription(
  description: string | null,
  maxLength: number,
): string | null {
  if (!description) {
    return null;
  }

  const plainText = decodeHtmlEntities(
    description
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();

  if (!plainText) {
    return null;
  }

  return truncateText(plainText, maxLength);
}

function truncateText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) {
    return value;
  }

  return `${chars.slice(0, Math.max(0, maxLength - 3)).join("").trimEnd()}...`;
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
