import {
  getAppTimezone,
  getFunctionPublicUrl,
  getRequiredEnv,
  handleFunctionError,
  HttpError,
  jsonResponse,
} from "../_shared/env.ts";
import {
  compareDealEvents,
  formatDealListLine,
  formatTodayLine,
} from "../_shared/events.ts";
import {
  dealKindLabel,
  formatDiscountPercent,
  formatKztAmount,
  getDealSnapshot,
  isGameDealEvent,
} from "../_shared/deals.ts";
import {
  ensureSource,
  type ExternalEventRow,
  queryString,
  type SourceRow,
  supabaseRequest,
  type SyncRunRow,
  upsertEventUserAction,
  upsertExternalEvents,
} from "../_shared/supabase.ts";
import {
  answerCallbackQuery,
  editMessageCaption,
  editMessageText,
  escapeHtml,
  type InlineKeyboardMarkup,
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
type DealListFilter = "all" | "free" | "discounts" | "wishlist";
type GameDealAction = "done" | "later" | "no_money" | "not_interested";

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

  try {
    const url = new URL(req.url);
    if (req.method !== "POST") {
      if (url.searchParams.get("view") === "dashboard") {
        return await renderDashboardResponse(url);
      }
      return jsonResponse({ ok: true, service: "telegram-webhook" });
    }

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
  } else if (command === "/wishlist") {
    await sendTelegramMessage(
      message.chat.id,
      await buildDealsMessage("wishlist"),
      dashboardKeyboard("wishlist"),
    );
  } else if (command === "/deals") {
    await sendTelegramMessage(
      message.chat.id,
      await buildDealsMessage("all"),
      dashboardKeyboard("all"),
    );
  } else if (command === "/free") {
    await sendTelegramMessage(
      message.chat.id,
      await buildDealsMessage("free"),
      dashboardKeyboard("free"),
    );
  } else if (command === "/status") {
    await sendTelegramMessage(
      message.chat.id,
      await buildStatusMessage(),
      dashboardKeyboard("all"),
    );
  } else if (command === "/test") {
    await sendTelegramMessage(
      message.chat.id,
      "Тестовое сообщение отправлено. Webhook работает.",
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
    await sendTelegramMessage(
      message.chat.id,
      buildHelpMessage(),
      dashboardKeyboard("all"),
    );
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
    "Отправьте картинку для этой задачи или напишите 'без картинки':",
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
    throw new Error("Нельзя создать задачу без названия");
  }

  const source = await ensureSource("personal_tasks", "Personal Tasks");
  if (!source.is_enabled) {
    throw new Error("Источник Personal Tasks отключен");
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
    await answerCallbackQuery(query.id, "Игнорирую");
    return;
  }

  const data = query.data || "";
  const gameDealMatch = data.match(
    /^game_deal_(done|later|no_money|not_interested)_([0-9a-f-]{36})$/i,
  );
  if (gameDealMatch) {
    const [, action, eventId] = gameDealMatch;
    await handleGameDealCallback(
      query,
      message,
      action as GameDealAction,
      eventId,
    );
    return;
  }

  const match = data.match(/^event_(done|mute|tomorrow)_([0-9a-f-]{36})$/i);
  if (!match) {
    await answerCallbackQuery(query.id, "Неизвестное действие");
    return;
  }

  const [, action, eventId] = match;
  if (action === "done") {
    await updateEventStatus(eventId, "done");
    await answerCallbackQuery(query.id, "Готово");
    await editTelegramMessage(
      message,
      "✅ Отметил как выполненное.",
    );
  } else if (action === "mute") {
    const until = new Date(Date.now() + 45 * 60000);
    await muteEvent(eventId, until, "telegram_callback:mute_45m");
    await resetNotificationState(eventId);
    await answerCallbackQuery(query.id, "Отложил на 45 минут");
    await editTelegramMessage(
      message,
      `⏳ Напомню снова: ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
  } else if (action === "tomorrow") {
    const until = tomorrowAtLocalHour(getAppTimezone(), 9);
    await muteEvent(eventId, until, "telegram_callback:tomorrow_9am");
    await resetNotificationState(eventId);
    await answerCallbackQuery(query.id, "Напомню завтра");
    await editTelegramMessage(
      message,
      `📅 Перенес на ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
  }
}

async function handleGameDealCallback(
  query: TelegramCallbackQuery,
  message: TelegramMessage,
  action: GameDealAction,
  eventId: string,
): Promise<void> {
  await upsertEventUserAction({
    event_id: eventId,
    chat_id: String(message.chat.id),
    action,
    payload_json: {
      callback_query_id: query.id,
      callback_data: query.data || "",
      message_id: message.message_id,
      recorded_at: new Date().toISOString(),
    },
  });

  if (action === "done") {
    await updateEventStatus(eventId, "done");
    await answerCallbackQuery(query.id, "Отметил");
    await editTelegramMessage(
      message,
      "✅ Куплено/забрано.",
    );
    return;
  }

  if (action === "later") {
    const until = new Date(Date.now() + 24 * 60 * 60000);
    await muteEvent(eventId, until, "telegram_callback:game_deal_later_24h");
    await resetNotificationState(eventId);
    await answerCallbackQuery(query.id, "Напомню позже");
    await editTelegramMessage(
      message,
      `⏳ Напомню позже: ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
    return;
  }

  if (action === "no_money") {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60000);
    await muteEvent(eventId, until, "telegram_callback:game_deal_no_money_7d");
    await resetNotificationState(eventId);
    await answerCallbackQuery(query.id, "Отложил");
    await editTelegramMessage(
      message,
      `💸 Вернусь к этому позже: ${
        escapeHtml(formatDateTime(until.toISOString(), getAppTimezone()))
      }.`,
    );
    return;
  }

  await updateEventStatus(eventId, "cancelled");
  await answerCallbackQuery(query.id, "Скрываю");
  await editTelegramMessage(
    message,
    "🤷 Больше не интересно.",
  );
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
    return "На сегодня активных событий и дедлайнов нет.";
  }

  return [
    "<b>Сегодня</b>",
    ...today.slice(0, 25).map((event) => formatTodayLine(event, timeZone)),
    today.length > 25 ? `...и еще ${today.length - 25}` : null,
  ].filter(Boolean).join("\n");
}

async function buildDealsMessage(filter: DealListFilter): Promise<string> {
  const timeZone = getAppTimezone();
  const deals = (await loadActiveEvents())
    .filter((event) => isGameDealEvent(event))
    .filter((event) => matchesDealFilter(event, filter))
    .sort(compareDealEvents);

  if (deals.length === 0) {
    return emptyDealsMessage(filter);
  }

  const header = dealsHeader(filter);
  const visible = deals.slice(0, 20);
  return [
    header,
    ...visible.map((event) => formatDealListLine(event, timeZone)),
    deals.length > visible.length
      ? `...показано ${visible.length} из ${deals.length}. Полный список есть в дашборде.`
      : null,
  ].filter(Boolean).join("\n");
}

async function buildStatusMessage(): Promise<string> {
  const timeZone = getAppTimezone();
  const sources = await supabaseRequest<SourceRow[]>(`sources?${
    queryString({
      select: "*",
      is_enabled: "eq.true",
      order: "name.asc",
    })
  }`);
  const events = await loadActiveEvents();
  const dealEvents = events.filter((event) => isGameDealEvent(event));
  const runs = await supabaseRequest<SyncRunRow[]>(`sync_runs?${
    queryString({
      select: "*,sources(kind,name)",
      order: "started_at.desc",
      limit: 20,
    })
  }`);
  const latestBySource = new Map<string, SyncRunRow>();
  for (const run of runs) {
    const sourceKind = run.sources?.kind;
    if (sourceKind && !latestBySource.has(sourceKind)) {
      latestBySource.set(sourceKind, run);
    }
  }

  const runLines = [...latestBySource.values()]
    .slice(0, 6)
    .map((run) =>
      `- ${escapeHtml(run.sources?.name || "Источник")} — ${
        escapeHtml(syncStatusLabel(run.status))
      }, ${escapeHtml(formatDateTime(run.started_at, timeZone))}`
    );

  return [
    "<b>Статус системы</b>",
    "Бот: работает",
    `Активных источников: ${sources.length}`,
    `Активных событий: ${events.length}`,
    `Активных игровых сделок: ${dealEvents.length}`,
    runLines.length > 0 ? "<b>Последняя синхронизация</b>" : null,
    ...runLines,
    runLines.length === 0 ? "Запусков синхронизации пока нет." : null,
  ].filter(Boolean).join("\n");
}

function buildHelpMessage(): string {
  return [
    "<b>Команды</b>",
    "/today - события и дедлайны на сегодня",
    "/wishlist - активные скидки из Steam Wishlist",
    "/deals - все активные игровые предложения",
    "/free - только бесплатные раздачи",
    "/status - состояние системы и последняя синхронизация",
    "/addtask - добавить личную задачу",
    "/cancel - отменить текущий диалог",
    "/help - показать справку",
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

function matchesDealFilter(
  event: ExternalEventRow,
  filter: DealListFilter,
): boolean {
  const deal = getDealSnapshot(event);
  if (!deal) {
    return false;
  }

  switch (filter) {
    case "free":
      return deal.dealKind === "free";
    case "discounts":
      return deal.dealKind === "huge_discount" ||
        deal.dealKind === "discount" ||
        deal.dealKind === "cheap";
    case "wishlist":
      return event.sources?.kind === "steam_wishlist";
    default:
      return true;
  }
}

function dealsHeader(filter: DealListFilter): string {
  switch (filter) {
    case "free":
      return "<b>Бесплатные игры</b>";
    case "discounts":
      return "<b>Скидки</b>";
    case "wishlist":
      return "<b>Steam Wishlist</b>";
    default:
      return "<b>Активные игровые предложения</b>";
  }
}

function emptyDealsMessage(filter: DealListFilter): string {
  switch (filter) {
    case "free":
      return "Сейчас нет активных бесплатных раздач.";
    case "discounts":
      return "Сейчас нет активных скидок.";
    case "wishlist":
      return "В Steam Wishlist сейчас нет подходящих сделок.";
    default:
      return "Сейчас нет активных игровых предложений.";
  }
}

function dashboardKeyboard(filter: DealListFilter): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{
      text: "📊 Открыть дашборд",
      url: dashboardUrl(filter),
    }]],
  };
}

function dashboardUrl(filter: DealListFilter): string {
  return getFunctionPublicUrl("telegram-webhook", {
    view: "dashboard",
    filter,
  });
}

async function renderDashboardResponse(url: URL): Promise<Response> {
  const filter = parseDealFilter(url.searchParams.get("filter"));
  const events = (await loadActiveEvents())
    .filter((event) => isGameDealEvent(event))
    .filter((event) => matchesDealFilter(event, filter))
    .sort(compareDealEvents);

  const cards = events.map((event) => renderDealCard(event)).join("");
  const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Дашборд скидок</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f2ea;
        --surface: #fffaf1;
        --ink: #1b1f18;
        --muted: #5f6757;
        --accent: #14705f;
        --accent-soft: #d9efe9;
        --border: #d7d0c3;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 980px;
        margin: 0 auto;
        padding: 24px 16px 48px;
      }
      .topbar {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
        flex-wrap: wrap;
        margin-bottom: 20px;
      }
      h1 {
        margin: 0;
        font-size: 32px;
        line-height: 1.1;
        letter-spacing: 0;
      }
      .meta {
        color: var(--muted);
        font-size: 14px;
        margin-top: 6px;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .filters a {
        text-decoration: none;
        color: var(--ink);
        padding: 10px 14px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.78);
        border-radius: 8px;
        font-size: 14px;
      }
      .filters a.active {
        background: var(--accent-soft);
        border-color: #93c7ba;
        color: #0e5347;
      }
      .list {
        display: grid;
        gap: 12px;
      }
      .deal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
      }
      .deal-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        margin-bottom: 10px;
      }
      .deal h2 {
        margin: 0;
        font-size: 20px;
        line-height: 1.2;
      }
      .badge {
        white-space: nowrap;
        font-size: 13px;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: #0d5a4c;
      }
      .deal-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }
      .label {
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
      }
      .value {
        font-size: 16px;
        margin-top: 4px;
      }
      .actions a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 120px;
        padding: 10px 14px;
        border-radius: 8px;
        background: var(--accent);
        color: white;
        text-decoration: none;
      }
      .empty {
        padding: 24px;
        border: 1px dashed var(--border);
        border-radius: 8px;
        color: var(--muted);
        background: rgba(255,255,255,0.45);
      }
      @media (max-width: 640px) {
        h1 { font-size: 26px; }
        .deal-top { flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="topbar">
        <div>
          <h1>Дашборд скидок</h1>
          <div class="meta">Фильтр: ${
    escapeHtml(dealsHeader(filter).replace(/<[^>]+>/g, ""))
  }. Активных предложений: ${events.length}</div>
        </div>
        <nav class="filters">
          ${renderDashboardFilter("all", filter, "Все")}
          ${renderDashboardFilter("free", filter, "Бесплатные")}
          ${renderDashboardFilter("discounts", filter, "Скидки")}
          ${renderDashboardFilter("wishlist", filter, "Steam Wishlist")}
        </nav>
      </div>
      <section class="list">
        ${
    cards ||
    '<div class="empty">Сейчас по этому фильтру ничего активного нет.</div>'
  }
      </section>
    </main>
  </body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderDashboardFilter(
  target: DealListFilter,
  current: DealListFilter,
  label: string,
): string {
  const href = dashboardUrl(target);
  const className = target === current ? "active" : "";
  return `<a class="${className}" href="${escapeHtml(href)}">${
    escapeHtml(label)
  }</a>`;
}

function renderDealCard(event: ExternalEventRow): string {
  const deal = getDealSnapshot(event);
  if (!deal) {
    return "";
  }

  const expiresAt = event.ends_at || event.due_at;
  const expiresText = expiresAt
    ? formatDateTime(expiresAt, getAppTimezone())
    : "Не указано";

  return `<article class="deal">
    <div class="deal-top">
      <div>
        <h2>${escapeHtml(deal.name)}</h2>
        <div class="meta">${escapeHtml(deal.storeLabel)}</div>
      </div>
      <div class="badge">${escapeHtml(dealKindLabel(deal.dealKind))}</div>
    </div>
    <div class="deal-grid">
      <div>
        <div class="label">Цена</div>
        <div class="value">${
    escapeHtml(formatKztAmount(deal.finalPriceKzt))
  }</div>
      </div>
      <div>
        <div class="label">Было</div>
        <div class="value">${
    escapeHtml(formatKztAmount(deal.originalPriceKzt))
  }</div>
      </div>
      <div>
        <div class="label">Скидка</div>
        <div class="value">-${
    escapeHtml(formatDiscountPercent(deal.discountPercent))
  }</div>
      </div>
      <div>
        <div class="label">Актуально до</div>
        <div class="value">${escapeHtml(expiresText)}</div>
      </div>
    </div>
    <div class="actions">
      <a href="${
    escapeHtml(deal.storeUrl)
  }" target="_blank" rel="noreferrer">Открыть магазин</a>
    </div>
  </article>`;
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

async function resetNotificationState(eventId: string): Promise<void> {
  await supabaseRequest<null>(
    `notification_state?${queryString({ event_id: `eq.${eventId}` })}`,
    {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    },
  );
}

async function editTelegramMessage(
  message: TelegramMessage,
  text: string,
): Promise<void> {
  if (message.photo?.length || message.caption) {
    await editMessageCaption(message.chat.id, message.message_id, text);
    return;
  }

  await editMessageText(message.chat.id, message.message_id, text);
}

function syncStatusLabel(status: SyncRunRow["status"]): string {
  switch (status) {
    case "success":
      return "успешно";
    case "error":
      return "ошибка";
    default:
      return "идет";
  }
}

function parseDealFilter(value: string | null): DealListFilter {
  if (
    value === "all" ||
    value === "free" ||
    value === "discounts" ||
    value === "wishlist"
  ) {
    return value;
  }
  return "all";
}

function assertTelegramWebhookSecret(req: Request): void {
  const expected = getRequiredEnv("TELEGRAM_WEBHOOK_SECRET");
  const actual = req.headers.get("x-telegram-bot-api-secret-token");
  if (actual !== expected) {
    throw new HttpError(401, "Invalid Telegram webhook secret");
  }
}
