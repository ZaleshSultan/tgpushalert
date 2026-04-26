import { getOptionalEnv, getTelegramToken, HttpError } from "./env.ts";
import { fetchWithTimeout } from "./http.ts";

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: {
    url: string;
  };
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramSendOptions {
  replyMarkup?: InlineKeyboardMarkup;
  disableNotification?: boolean;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function getDefaultChatId(): string {
  return getOptionalEnv("TELEGRAM_CHAT_ID") || getOptionalEnv("CHAT_ID");
}

export function assertAllowedChat(chatId: number | string): void {
  if (isAllowedChat(chatId)) {
    return;
  }

  throw new HttpError(403, "Telegram chat is not allowed");
}

export function isAllowedChat(chatId: number | string): boolean {
  const allowed = getDefaultChatId();
  if (!allowed) {
    return true;
  }

  return String(chatId) === String(allowed);
}

export async function telegramApi<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const token = getTelegramToken();
  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      label: `Telegram ${method}`,
    },
  );
  const data = await response.json() as TelegramResponse<T>;
  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${data.description || response.statusText}`,
    );
  }
  return data.result as T;
}

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  options?: InlineKeyboardMarkup | TelegramSendOptions,
): Promise<void> {
  const normalized = normalizeSendOptions(options);
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(normalized.disableNotification ? { disable_notification: true } : {}),
    ...(normalized.replyMarkup ? { reply_markup: normalized.replyMarkup } : {}),
  });
}

export async function sendTelegramPhoto(
  chatId: string | number,
  photoFileId: string,
  caption: string,
  options?: InlineKeyboardMarkup | TelegramSendOptions,
): Promise<void> {
  const normalized = normalizeSendOptions(options);
  await telegramApi("sendPhoto", {
    chat_id: chatId,
    photo: photoFileId,
    caption,
    parse_mode: "HTML",
    ...(normalized.disableNotification ? { disable_notification: true } : {}),
    ...(normalized.replyMarkup ? { reply_markup: normalized.replyMarkup } : {}),
  });
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
): Promise<void> {
  await telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export async function editMessageCaption(
  chatId: number | string,
  messageId: number,
  caption: string,
): Promise<void> {
  await telegramApi("editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
  });
}

function normalizeSendOptions(
  options?: InlineKeyboardMarkup | TelegramSendOptions,
): TelegramSendOptions {
  if (!options) {
    return {};
  }
  if ("inline_keyboard" in options) {
    return { replyMarkup: options };
  }
  return options;
}
