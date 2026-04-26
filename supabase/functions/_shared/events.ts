import {
  dealAlertType,
  dealKindLabel,
  dealSortWeight,
  formatDiscountPercent,
  formatKztAmount,
  getDealSnapshot,
  isGameDealEvent,
} from "./deals.ts";
import type { ExternalEventRow } from "./supabase.ts";
import type { InlineKeyboardMarkup } from "./telegram.ts";
import { escapeHtml } from "./telegram.ts";
import { eventTimeIso, formatDateTime } from "./time.ts";

export function chooseAlertType(
  event: ExternalEventRow,
  now = new Date(),
): string | null {
  if (isGameDealEvent(event)) {
    const deal = getDealSnapshot(event);
    return deal ? dealAlertType(deal.dealKind) : null;
  }

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
    return formatGameDealAlertMessage(event);
  }

  const titleParts = splitEventTitle(event.title);
  const alertKind = resolveAlertKind(event);
  const when = formatAlertWhen(event, alertKind.iso, timeZone);
  const description = cleanDescription(event.description, 150);

  const lines = [
    `${alertKind.emoji} <b>${alertKind.label}: ${
      escapeHtml(titleParts.subject)
    }</b>`,
    `📌 <b>Задача/событие:</b> ${escapeHtml(titleParts.name)}`,
    when ? `⏰ <b>${alertKind.timeLabel}:</b> ${escapeHtml(when)}` : null,
    description ? `📝 <i>${escapeHtml(description)}</i>` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

export function formatTodayLine(
  event: ExternalEventRow,
  timeZone: string,
): string {
  if (isGameDealEvent(event)) {
    return formatDealListLine(event, timeZone);
  }

  const iso = eventTimeIso(event);
  const source = event.sources?.name || "Life OS";
  const when = formatWhen(event, timeZone, iso);
  return `- ${escapeHtml(when)} | ${escapeHtml(source)} | ${
    escapeHtml(event.title)
  }`;
}

export function formatDealListLine(
  event: ExternalEventRow,
  timeZone: string,
): string {
  const deal = getDealSnapshot(event);
  if (!deal) {
    return `- ${escapeHtml(event.title)}`;
  }

  const endAt = event.ends_at || event.due_at;
  const timeSuffix = deal.dealKind === "free" && endAt
    ? ` до ${escapeHtml(formatDateTime(endAt, timeZone))}`
    : "";

  return [
    `- ${escapeHtml(deal.storeLabel)} | ${escapeHtml(deal.name)}`,
    `  ${escapeHtml(dealKindLabel(deal.dealKind))} | ${
      escapeHtml(formatKztAmount(deal.finalPriceKzt))
    } (было ${escapeHtml(formatKztAmount(deal.originalPriceKzt))}, -${
      escapeHtml(formatDiscountPercent(deal.discountPercent))
    })${timeSuffix}`,
  ].join("\n");
}

export function compareDealEvents(
  left: ExternalEventRow,
  right: ExternalEventRow,
): number {
  const leftDeal = getDealSnapshot(left);
  const rightDeal = getDealSnapshot(right);
  const leftWeight = leftDeal ? dealSortWeight(leftDeal.dealKind) : 99;
  const rightWeight = rightDeal ? dealSortWeight(rightDeal.dealKind) : 99;
  if (leftWeight !== rightWeight) {
    return leftWeight - rightWeight;
  }

  const leftUpdated = left.updated_at || "";
  const rightUpdated = right.updated_at || "";
  return rightUpdated.localeCompare(leftUpdated) ||
    left.title.localeCompare(right.title, "ru");
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
          text: "🤷 не интересно",
          callback_data: `game_deal_not_interested_${eventId}`,
        }],
      ],
    };
  }

  return {
    inline_keyboard: [
      [{ text: "✅ готово", callback_data: `event_done_${eventId}` }],
      [{
        text: "⏳ отложить на 45 минут",
        callback_data: `event_mute_${eventId}`,
      }],
      [{
        text: "📅 напомнить завтра",
        callback_data: `event_tomorrow_${eventId}`,
      }],
    ],
  };
}

function formatGameDealAlertMessage(event: ExternalEventRow): string {
  const deal = getDealSnapshot(event);
  if (!deal) {
    return `🎮 ${escapeHtml(event.title)}`;
  }

  return [
    `🎮 <b>${escapeHtml(deal.name)}</b>`,
    `💸 Цена: ${escapeHtml(formatKztAmount(deal.finalPriceKzt))} (было ${
      escapeHtml(formatKztAmount(deal.originalPriceKzt))
    })`,
    `📉 Скидка: ${escapeHtml(formatDiscountPercent(deal.discountPercent))}`,
    `🔗 ${escapeHtml(deal.storeUrl)}`,
  ].join("\n");
}

function formatWhen(
  event: ExternalEventRow,
  timeZone: string,
  fallbackIso: string | null,
): string {
  if (isDateOnlyGoogleTask(event) && event.due_date) {
    return `${formatRuDateOnly(event.due_date, timeZone)} (без времени)`;
  }
  return fallbackIso ? formatDateTime(fallbackIso, timeZone) : "без времени";
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
