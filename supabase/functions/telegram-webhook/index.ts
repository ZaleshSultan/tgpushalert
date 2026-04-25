import {
  getAppTimezone,
  getRequiredEnv,
  handleFunctionError,
  HttpError,
  jsonResponse,
} from "../_shared/env.ts";
import { formatTodayLine } from "../_shared/events.ts";
import {
  ensureSource,
  type ExternalEventRow,
  queryString,
  type SourceRow,
  supabaseRequest,
  type SyncRunRow,
  upsertExternalEvents,
} from "../_shared/supabase.ts";
import {
  answerCallbackQuery,
  editMessageText,
  escapeHtml,
  isAllowedChat,
  sendTelegramMessage,
} from "../_shared/telegram.ts";
import {
  eventTimeIso,
  formatDateTime,
  isSameLocalDate,
  tomorrowAtLocalHour,
  zonedTimeToUtc,
} from "../_shared/time.ts";

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: { file_id: string; mime_type?: string; file_name?: string };
  chat: {
    id: number;
  };
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface BotMetaRow {
  key: string;
  value_json: Record<string, unknown>;
  updated_at: string;
}

type AddTaskStep = "awaiting_details" | "awaiting_due_at" | "awaiting_photo";

interface AddTaskState {
  step: AddTaskStep;
  title?: string;
  description?: string | null;
  due_at?: string | null;
  created_at: string;
  updated_at: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: true, service: "telegram-webhook" });
  }

  try {
    assertTelegramWebhookSecret(req);
    const update = await req.json() as TelegramUpdate;

    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    return handleFunctionError(error);
  }
});

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!isAllowedChat(message.chat.id)) {
    return;
  }

  const text = message.text?.trim();
  const command = text?.startsWith("/")
    ? text.split(/\s+/)[0].split("@")[0].toLowerCase()
    : "";
  if (command === "/today") {
    await sendTelegramMessage(message.chat.id, await buildTodayMessage());
  } else if (command === "/status") {
    await sendTelegramMessage(message.chat.id, await buildStatusMessage());
  } else if (command === "/test") {
    await sendTelegramMessage(
      message.chat.id,
      "Test message OK. Telegram webhook is alive.",
    );
  } else if (command === "/addtask") {
    await startAddTaskFlow(message.chat.id);
  } else if (command === "/cancel") {
    await clearAddTaskState(message.chat.id);
    await sendTelegramMessage(
      message.chat.id,
      "Диалог добавления задачи отменен.",
    );
  } else if (command === "/help" || command === "/start") {
    await sendTelegramMessage(message.chat.id, buildHelpMessage());
  } else {
    const state = await loadAddTaskState(message.chat.id);
    if (state) {
      await continueAddTaskFlow(message, state);
    }
  }
}

async function startAddTaskFlow(chatId: number): Promise<void> {
  const now = new Date().toISOString();
  await saveAddTaskState(chatId, {
    step: "awaiting_details",
    created_at: now,
    updated_at: now,
  });
  await sendTelegramMessage(
    chatId,
    "Введите название и описание задачи:",
  );
}

async function continueAddTaskFlow(
  message: TelegramMessage,
  state: AddTaskState,
): Promise<void> {
  if (state.step === "awaiting_details") {
    await handleTaskDetailsStep(message, state);
    return;
  }

  if (state.step === "awaiting_due_at") {
    await handleTaskDueAtStep(message, state);
    return;
  }

  await handleTaskPhotoStep(message, state);
}

async function handleTaskDetailsStep(
  message: TelegramMessage,
  state: AddTaskState,
): Promise<void> {
  const text = message.text?.trim();
  if (!text) {
    await sendTelegramMessage(
      message.chat.id,
      "Введите название и описание задачи текстом:",
    );
    return;
  }

  const details = splitTaskDetails(text);
  if (!details.title) {
    await sendTelegramMessage(
      message.chat.id,
      "Название задачи не должно быть пустым. Введите название и описание:",
    );
    return;
  }

  await saveAddTaskState(message.chat.id, {
    ...state,
    step: "awaiting_due_at",
    title: details.title,
    description: details.description,
    updated_at: new Date().toISOString(),
  });
  await sendTelegramMessage(
    message.chat.id,
    "Введите дату и время дедлайна (например, 2026-04-25 15:00) или напишите 'пропустить':",
  );
}

async function handleTaskDueAtStep(
  message: TelegramMessage,
  state: AddTaskState,
): Promise<void> {
  const text = message.text?.trim();
  if (!text) {
    await sendTelegramMessage(
      message.chat.id,
      "Введите дату и время дедлайна текстом или напишите 'пропустить':",
    );
    return;
  }

  const dueAt = isSkippedDeadline(text)
    ? null
    : parseUserDeadline(text, getAppTimezone());
  if (dueAt === undefined) {
    await sendTelegramMessage(
      message.chat.id,
      "Не смог распознать дату. Используйте формат 2026-04-25 15:00 или напишите 'пропустить':",
    );
    return;
  }

  await saveAddTaskState(message.chat.id, {
    ...state,
    step: "awaiting_photo",
    due_at: dueAt,
    updated_at: new Date().toISOString(),
  });
  await sendTelegramMessage(
    message.chat.id,
    "Отправьте картинку для этой задачи (или напишите 'без картинки'):",
  );
}

async function handleTaskPhotoStep(
  message: TelegramMessage,
  state: AddTaskState,
): Promise<void> {
  const documentPhotoId = message.document?.mime_type?.startsWith("image/")
    ? message.document.file_id
    : null;
  const photoId = largestPhotoFileId(message.photo) ?? documentPhotoId;
  const isSkipped = isSkippedPhoto(message.text) ||
    isSkippedPhoto(message.caption);

  if (!photoId && !isSkipped) {
    await sendTelegramMessage(
      message.chat.id,
      "Отправьте картинку для этой задачи или напишите 'без картинки':",
    );
    return;
  }

  const event = await createPersonalTaskEvent(message.chat.id, state, photoId);
  await clearAddTaskState(message.chat.id);

  const due = event.due_at
    ? formatDateTime(event.due_at, getAppTimezone())
    : "без дедлайна";
  await sendTelegramMessage(
    message.chat.id,
    [
      "Задача сохранена.",
      `Название: ${escapeHtml(event.title)}`,
      `Дедлайн: ${escapeHtml(due)}`,
      photoId ? "Картинка прикреплена." : "Без картинки.",
    ].join("\n"),
  );
}

async function createPersonalTaskEvent(
  chatId: number,
  state: AddTaskState,
  photoId: string | null,
): Promise<ExternalEventRow> {
  if (!state.title) {
    throw new Error("Cannot create personal task without a title");
  }

  const source = await ensureSource("personal_tasks", "Personal Tasks");
  if (!source.is_enabled) {
    throw new Error("Personal Tasks source is disabled");
  }

  const rows = await upsertExternalEvents([{
    source_id: source.id,
    external_id: `telegram:${chatId}:${crypto.randomUUID()}`,
    title: state.title,
    description: state.description || null,
    due_at: state.due_at || null,
    has_explicit_time: Boolean(state.due_at),
    raw_payload_json: photoId ? { telegram_photo_id: photoId } : {},
    status: "active",
  }]);
  return rows[0];
}

function splitTaskDetails(text: string): {
  title: string;
  description: string | null;
} {
  const [firstLine = "", ...rest] = text.replace(/\r\n/g, "\n").trim().split(
    "\n",
  );
  const title = firstLine.trim();
  const description = rest.join("\n").trim() || null;
  return { title, description };
}

function isSkippedDeadline(text: string): boolean {
  return ["пропустить", "skip", "без дедлайна", "нет"].includes(
    text.trim().toLowerCase(),
  );
}

function parseUserDeadline(
  text: string,
  timeZone: string,
): string | null | undefined {
  const match = text.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/,
  );
  if (!match) {
    return undefined;
  }

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);

  if (
    !Number.isInteger(year) ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    return undefined;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day ||
    utcDate.getUTCHours() !== hour ||
    utcDate.getUTCMinutes() !== minute
  ) {
    return undefined;
  }

  return zonedTimeToUtc({
    year,
    month,
    day,
    hour,
    minute,
    second: 0,
  }, timeZone).toISOString();
}

function largestPhotoFileId(
  photos: TelegramPhotoSize[] | undefined,
): string | null {
  if (!photos?.length) {
    return null;
  }

  return photos.reduce((best, current) =>
    photoScore(current) > photoScore(best) ? current : best
  ).file_id;
}

function photoScore(photo: TelegramPhotoSize): number {
  return photo.file_size || photo.width * photo.height;
}

function isSkippedPhoto(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  return [
    "без картинки",
    "без фото",
    "нет",
    "пропустить",
    "skip",
  ].includes(text.trim().toLowerCase());
}

async function loadAddTaskState(chatId: number): Promise<AddTaskState | null> {
  const rows = await supabaseRequest<BotMetaRow[]>(
    `bot_meta?${
      queryString({
        select: "key,value_json,updated_at",
        key: `eq.${addTaskStateKey(chatId)}`,
        limit: 1,
      })
    }`,
  );
  return rows[0] ? normalizeAddTaskState(rows[0].value_json) : null;
}

async function saveAddTaskState(
  chatId: number,
  state: AddTaskState,
): Promise<void> {
  const params = queryString({ on_conflict: "key" });
  await supabaseRequest<null>(`bot_meta?${params}`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      key: addTaskStateKey(chatId),
      value_json: state,
      updated_at: state.updated_at,
    }]),
  });
}

async function clearAddTaskState(chatId: number): Promise<void> {
  await supabaseRequest<null>(
    `bot_meta?${queryString({ key: `eq.${addTaskStateKey(chatId)}` })}`,
    {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    },
  );
}

function addTaskStateKey(chatId: number): string {
  return `telegram_addtask:${chatId}`;
}

function normalizeAddTaskState(
  value: Record<string, unknown>,
): AddTaskState | null {
  const step = value.step;
  if (
    step !== "awaiting_details" &&
    step !== "awaiting_due_at" &&
    step !== "awaiting_photo"
  ) {
    return null;
  }

  const createdAt = typeof value.created_at === "string"
    ? value.created_at
    : new Date().toISOString();
  const updatedAt = typeof value.updated_at === "string"
    ? value.updated_at
    : createdAt;
  return {
    step,
    title: typeof value.title === "string" ? value.title : undefined,
    description: typeof value.description === "string"
      ? value.description
      : null,
    due_at: typeof value.due_at === "string" ? value.due_at : null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

async function handleCallback(query: TelegramCallbackQuery): Promise<void> {
  const message = query.message;
  if (!message || !isAllowedChat(message.chat.id)) {
    await answerCallbackQuery(query.id, "Ignored");
    return;
  }

  const data = query.data || "";
  const gameDealMatch = data.match(
    /^game_deal_(done|later|no_money|not_interested)_([0-9a-f-]{36})$/i,
  );
  if (gameDealMatch) {
    const [, action, eventId] = gameDealMatch;
    await handleGameDealCallback(query, message, action, eventId);
    return;
  }

  const match = data.match(/^event_(done|mute|tomorrow)_([0-9a-f-]{36})$/i);
  if (!match) {
    await answerCallbackQuery(query.id, "Unsupported action");
    return;
  }

  const [, action, eventId] = match;
  if (action === "done") {
    await updateEventStatus(eventId, "done");
    await answerCallbackQuery(query.id, "Marked done");
    await editMessageText(
      message.chat.id,
      message.message_id,
      "✅ Marked done.",
    );
  } else if (action === "mute") {
    const until = new Date(Date.now() + 45 * 60000);
    await muteEvent(eventId, until, "telegram_callback:mute_45m");
    await answerCallbackQuery(query.id, "Muted for 45 minutes");
    await editMessageText(
      message.chat.id,
      message.message_id,
      `⏳ Muted until ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
  } else if (action === "tomorrow") {
    const until = tomorrowAtLocalHour(getAppTimezone(), 9);
    await muteEvent(eventId, until, "telegram_callback:tomorrow_9am");
    await answerCallbackQuery(query.id, "Snoozed until tomorrow");
    await editMessageText(
      message.chat.id,
      message.message_id,
      `📅 Snoozed until ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
  }
}

async function handleGameDealCallback(
  query: TelegramCallbackQuery,
  message: TelegramMessage,
  action: string,
  eventId: string,
): Promise<void> {
  if (action === "done") {
    await updateEventStatus(eventId, "done");
    await answerCallbackQuery(query.id, "Marked done");
    await editMessageText(
      message.chat.id,
      message.message_id,
      "✅ Куплено/забрано.",
    );
    return;
  }

  if (action === "later") {
    const until = new Date(Date.now() + 24 * 60 * 60000);
    await muteEvent(eventId, until, "telegram_callback:game_deal_later_24h");
    await answerCallbackQuery(query.id, "Snoozed for 24 hours");
    await editMessageText(
      message.chat.id,
      message.message_id,
      `⏳ Напомню позже: ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
    return;
  }

  if (action === "no_money") {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60000);
    await muteEvent(eventId, until, "telegram_callback:game_deal_no_money_7d");
    await answerCallbackQuery(query.id, "Muted for 7 days");
    await editMessageText(
      message.chat.id,
      message.message_id,
      `💸 Отложено до ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
    return;
  }

  if (action === "not_interested") {
    await updateEventStatus(eventId, "cancelled");
    await answerCallbackQuery(query.id, "Cancelled");
    await editMessageText(
      message.chat.id,
      message.message_id,
      "🙅 Больше не интересно.",
    );
  }
}

async function buildTodayMessage(): Promise<string> {
  const timeZone = getAppTimezone();
  const now = new Date();
  const events = await loadActiveEvents();
  const today = events
    .filter((event) => {
      const iso = eventTimeIso(event);
      return iso ? isSameLocalDate(iso, now, timeZone) : false;
    })
    .sort((left, right) => {
      const leftTime = eventTimeIso(left) || "";
      const rightTime = eventTimeIso(right) || "";
      return leftTime.localeCompare(rightTime);
    });

  if (today.length === 0) {
    return "No active deadlines or events for today.";
  }

  return [
    `<b>Today</b>`,
    ...today.slice(0, 25).map((event) => formatTodayLine(event, timeZone)),
    today.length > 25 ? `...and ${today.length - 25} more` : null,
  ].filter(Boolean).join("\n");
}

async function buildStatusMessage(): Promise<string> {
  const timeZone = getAppTimezone();
  const sources = await supabaseRequest<SourceRow[]>(`sources?${
    queryString({
      select: "*",
      is_enabled: "eq.true",
    })
  }`);
  const events = await loadActiveEvents();
  const runs = await supabaseRequest<SyncRunRow[]>(`sync_runs?${
    queryString({
      select: "*",
      order: "started_at.desc",
      limit: 1,
    })
  }`);
  const lastRun = runs[0];
  const lastSync = lastRun
    ? `${lastRun.status} at ${formatDateTime(lastRun.started_at, timeZone)}`
    : "no sync runs yet";

  return [
    "<b>Status</b>",
    "Bot: alive",
    `Active sources: ${sources.length}`,
    `Active events: ${events.length}`,
    `Last sync: ${escapeHtml(lastSync)}`,
  ].join("\n");
}

function buildHelpMessage(): string {
  return [
    "<b>Commands</b>",
    "/today - deadlines and events for today",
    "/status - bot health and latest sync",
    "/test - send a test response",
    "/addtask - add a personal task with optional image",
    "/cancel - cancel the current dialog",
    "/help - show this help",
  ].join("\n");
}

async function loadActiveEvents(): Promise<ExternalEventRow[]> {
  return await supabaseRequest<ExternalEventRow[]>(
    `external_events?${
      queryString({
        select: "*,sources(kind,name)",
        status: "eq.active",
        alert_at: "not.is.null",
        order: "alert_at.asc",
        limit: 300,
      })
    }`,
  );
}

async function updateEventStatus(
  eventId: string,
  status: "done" | "cancelled",
): Promise<void> {
  await supabaseRequest<null>(
    `external_events?${queryString({ id: `eq.${eventId}` })}`,
    {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status }),
    },
  );
}

async function muteEvent(
  eventId: string,
  mutedUntil: Date,
  reason: string,
): Promise<void> {
  await supabaseRequest<null>("muted_items", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify([{
      item_kind: "event",
      item_ref: eventId,
      muted_until: mutedUntil.toISOString(),
      reason,
    }]),
  });
}

function assertTelegramWebhookSecret(req: Request): void {
  const expected = getRequiredEnv("TELEGRAM_WEBHOOK_SECRET");
  const actual = req.headers.get("x-telegram-bot-api-secret-token");
  if (actual !== expected) {
    throw new HttpError(401, "Invalid Telegram webhook secret");
  }
}
