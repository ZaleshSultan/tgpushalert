import {
  assertCronSecret,
  getAppTimezone,
  getOptionalEnv,
  handleFunctionError,
  jsonResponse,
} from "../_shared/env.ts";
import { getDealSnapshot, isGameDealEvent } from "../_shared/deals.ts";
import {
  chooseAlertType,
  eventKeyboard,
  formatAlertMessage,
} from "../_shared/events.ts";
import {
  enqueueTaskCommand,
  type ExternalEventRow,
  type MutedItemRow,
  type NotificationStateRow,
  queryString,
  supabaseRequest,
} from "../_shared/supabase.ts";
import {
  getDefaultChatId,
  sendTelegramMessage,
  sendTelegramPhoto,
} from "../_shared/telegram.ts";
import { localTimeString } from "../_shared/time.ts";

interface DispatchStats {
  loaded_events: number;
  nag_candidates: number;
  muted: number;
  filtered_no_alert_type: number;
  candidates: number;
  sent_telegram: number;
  sent_nag: number;
  queued_google_tasks: number;
  skipped_same_checksum: number;
  skipped_ignore: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    assertCronSecret(req);

    const chatId = getDefaultChatId();
    if (!chatId) {
      throw new Error("Missing TELEGRAM_CHAT_ID or CHAT_ID");
    }

    const url = new URL(req.url);
    const force = isTruthy(url.searchParams.get("force")) ||
      isTruthy(req.headers.get("x-force-resend"));
    const forceTasks = isTruthy(url.searchParams.get("force_tasks")) ||
      isTruthy(req.headers.get("x-force-tasks"));

    const timeZone = getAppTimezone();
    const now = new Date();
    const cooldownMinutes = Number(
      getOptionalEnv("ALERT_COOLDOWN_MINUTES", "30"),
    );
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
      throw new Error(
        "ALERT_COOLDOWN_MINUTES must be zero or a positive number",
      );
    }
    const lookaheadHours = Number(
      getOptionalEnv("ALERT_LOOKAHEAD_HOURS", "24"),
    );
    if (!Number.isFinite(lookaheadHours) || lookaheadHours <= 0) {
      throw new Error("ALERT_LOOKAHEAD_HOURS must be a positive number");
    }
    const nagIntervalMinutes = Number(
      getOptionalEnv("TASK_NAG_INTERVAL_MINUTES", "10"),
    );
    if (!Number.isFinite(nagIntervalMinutes) || nagIntervalMinutes < 1) {
      throw new Error("TASK_NAG_INTERVAL_MINUTES must be at least 1");
    }

    const events = await loadAlertWindowEvents(now, lookaheadHours);
    const nagCandidates = await loadNagCandidates(now);
    const nagEventIds = new Set(nagCandidates.map((event) => event.id));
    const mutedEventIds = await loadMutedEventIds(now);
    const routed = events
      .map((event) => ({ event, alertType: chooseAlertType(event, now) }))
      .filter((item): item is { event: ExternalEventRow; alertType: string } =>
        Boolean(item.alertType)
      );
    const candidates = routed.filter((item) =>
      !mutedEventIds.has(item.event.id) && !nagEventIds.has(item.event.id)
    );

    const states = await loadNotificationStates(
      candidates.map((item) => item.event.id),
    );
    const stateByKey = new Map(
      states.map((state) => [`${state.event_id}:${state.alert_type}`, state]),
    );

    const stats: DispatchStats = {
      loaded_events: events.length,
      nag_candidates: nagCandidates.length,
      muted: routed.length - candidates.length,
      filtered_no_alert_type: events.length - routed.length,
      candidates: candidates.length,
      sent_telegram: 0,
      sent_nag: 0,
      queued_google_tasks: 0,
      skipped_same_checksum: 0,
      skipped_ignore: 0,
    };

    console.log("[dispatch-alerts] started", {
      loadedEvents: stats.loaded_events,
      filteredNoAlertType: stats.filtered_no_alert_type,
      candidates: stats.candidates,
      nagCandidates: stats.nag_candidates,
      muted: stats.muted,
      force,
      forceTasks,
    });

    for (const candidate of candidates) {
      const signature = eventSignature(candidate.event);
      const telegramKey = `${candidate.event.id}:${candidate.alertType}`;
      const telegramState = stateByKey.get(telegramKey);
      const isDuplicate = telegramState?.event_checksum === signature;

      if (!force && isDuplicate) {
        stats.skipped_same_checksum += 1;
        console.log("[dispatch-alerts] skip duplicate", {
          eventId: candidate.event.id,
          alertType: candidate.alertType,
          title: candidate.event.title,
        });
        continue;
      }

      if (isGameDealEvent(candidate.event)) {
        const deal = getDealSnapshot(candidate.event);
        if (
          !deal || candidate.alertType === null || deal.dealKind === "ignore"
        ) {
          stats.skipped_ignore += 1;
          console.log("[dispatch-alerts] skip ignored deal", {
            eventId: candidate.event.id,
            title: candidate.event.title,
          });
          continue;
        }

        const disableNotification = deal.dealKind === "cheap";
        await sendEventToTelegram(
          chatId,
          candidate.event,
          timeZone,
          disableNotification,
        );
        await recordNotification(
          candidate.event.id,
          candidate.alertType,
          signature,
          cooldownMinutes,
        );
        stateByKey.set(telegramKey, {
          id: telegramState?.id || "",
          event_id: candidate.event.id,
          alert_type: candidate.alertType,
          event_checksum: signature,
          notified_at: now.toISOString(),
          cooldown_until: null,
        });
        stats.sent_telegram += 1;

        if (deal.dealKind === "free") {
          const taskKey = `${candidate.event.id}:google_task`;
          const taskState = stateByKey.get(taskKey);
          const taskDuplicate = taskState?.event_checksum === signature;
          if (!taskDuplicate || forceTasks) {
            await queueGoogleTaskForDeal(chatId, candidate.event, timeZone);
            await recordNotification(
              candidate.event.id,
              "google_task",
              signature,
              0,
            );
            stateByKey.set(taskKey, {
              id: taskState?.id || "",
              event_id: candidate.event.id,
              alert_type: "google_task",
              event_checksum: signature,
              notified_at: now.toISOString(),
              cooldown_until: null,
            });
            stats.queued_google_tasks += 1;
          }
        }

        console.log("[dispatch-alerts] sent deal", {
          eventId: candidate.event.id,
          alertType: candidate.alertType,
          dealKind: deal.dealKind,
          force,
        });
        continue;
      }

      await sendEventToTelegram(chatId, candidate.event, timeZone, false);
      await recordNotification(
        candidate.event.id,
        candidate.alertType,
        signature,
        cooldownMinutes,
      );
      stateByKey.set(telegramKey, {
        id: telegramState?.id || "",
        event_id: candidate.event.id,
        alert_type: candidate.alertType,
        event_checksum: signature,
        notified_at: now.toISOString(),
        cooldown_until: null,
      });
      stats.sent_telegram += 1;

      console.log("[dispatch-alerts] sent regular event", {
        eventId: candidate.event.id,
        alertType: candidate.alertType,
        title: candidate.event.title,
        force,
      });
    }

    for (const event of nagCandidates) {
      if (mutedEventIds.has(event.id)) {
        continue;
      }
      if (!force && !shouldNagNow(event, now, nagIntervalMinutes)) {
        continue;
      }

      await sendEventToTelegram(chatId, event, timeZone, false);
      await recordNotification(
        event.id,
        "nag_10m",
        eventSignature(event),
        nagIntervalMinutes,
      );
      await markEventNagged(event.id, now);
      stats.sent_telegram += 1;
      stats.sent_nag += 1;

      console.log("[dispatch-alerts] sent nag", {
        eventId: event.id,
        title: event.title,
        dueDate: event.due_date,
        force,
      });
    }

    console.log("[dispatch-alerts] completed", stats);
    return jsonResponse({
      ok: true,
      force,
      force_tasks: forceTasks,
      ...stats,
    });
  } catch (error) {
    return handleFunctionError(error);
  }
});

async function loadAlertWindowEvents(
  now: Date,
  lookaheadHours: number,
): Promise<ExternalEventRow[]> {
  const pastFloor = new Date(now.getTime() - 2 * 60 * 60000);
  const futureCeiling = new Date(now.getTime() + lookaheadHours * 60 * 60000);

  const eventParams = queryString({
    select: "*,sources(kind,name)",
    status: "eq.active",
    alert_at: "not.is.null",
    and:
      `(alert_at.gte.${pastFloor.toISOString()},alert_at.lte.${futureCeiling.toISOString()})`,
    order: "alert_at.asc",
    limit: 500,
  });
  return await supabaseRequest<ExternalEventRow[]>(
    `external_events?${eventParams}`,
  );
}

async function loadNagCandidates(
  now: Date,
): Promise<ExternalEventRow[]> {
  const sourceRows = await supabaseRequest<Array<{ id: string }>>(
    `sources?${
      queryString({
        select: "id",
        kind: "eq.google_tasks",
        is_enabled: "eq.true",
      })
    }`,
  );
  if (sourceRows.length === 0) {
    return [];
  }

  const sourceIds = sourceRows.map((row) => row.id);
  const params = queryString({
    select: "*,sources(kind,name)",
    status: "eq.active",
    source_id: `in.(${sourceIds.join(",")})`,
    is_important: "eq.true",
    alert_at: `lte.${now.toISOString()}`,
    order: "alert_at.asc,updated_at.asc",
    limit: 500,
  });
  return await supabaseRequest<ExternalEventRow[]>(
    `external_events?${params}`,
  );
}

async function loadMutedEventIds(now: Date): Promise<Set<string>> {
  const mutedParams = queryString({
    select: "*",
    item_kind: "eq.event",
    muted_until: `gt.${now.toISOString()}`,
  });
  const mutedItems = await supabaseRequest<MutedItemRow[]>(
    `muted_items?${mutedParams}`,
  );
  return new Set(mutedItems.map((item) => item.item_ref));
}

function shouldNagNow(
  event: ExternalEventRow,
  now: Date,
  intervalMinutes: number,
): boolean {
  if (!event.last_nagged_at) {
    return true;
  }
  const lastNagged = new Date(event.last_nagged_at);
  if (Number.isNaN(lastNagged.getTime())) {
    return true;
  }
  return now.getTime() >= lastNagged.getTime() + intervalMinutes * 60000;
}

async function markEventNagged(eventId: string, now: Date): Promise<void> {
  await supabaseRequest<null>(
    `external_events?${queryString({ id: `eq.${eventId}` })}`,
    {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ last_nagged_at: now.toISOString() }),
    },
  );
}

async function sendEventToTelegram(
  chatId: string,
  event: ExternalEventRow,
  timeZone: string,
  disableNotification: boolean,
): Promise<void> {
  const message = formatAlertMessage(event, timeZone);
  const keyboard = eventKeyboard(event);
  const photoId = telegramPhotoId(event);
  if (photoId) {
    await sendTelegramPhoto(
      chatId,
      photoId,
      truncateTelegramCaption(message),
      {
        replyMarkup: keyboard,
        disableNotification,
      },
    );
    return;
  }

  await sendTelegramMessage(chatId, message, {
    replyMarkup: keyboard,
    disableNotification,
  });
}

async function queueGoogleTaskForDeal(
  chatId: string,
  event: ExternalEventRow,
  timeZone: string,
): Promise<void> {
  const deal = getDealSnapshot(event);
  if (!deal) {
    throw new Error(`Cannot queue Google Task for non-deal event ${event.id}`);
  }

  const dueDate = resolveTaskDueDate(event, timeZone);
  const dueTime = resolveTaskDueTime(event, timeZone);
  await enqueueTaskCommand({
    chat_id: chatId,
    title: `Забрать игру: ${deal.name}`,
    due_date: dueDate,
    due_time: dueTime,
    timezone: timeZone,
  });
}

function resolveTaskDueDate(event: ExternalEventRow, timeZone: string): string {
  if (event.due_date) {
    return event.due_date;
  }

  const dueSource = event.ends_at || event.due_at || event.remind_at;
  if (dueSource) {
    return localDateString(new Date(dueSource), timeZone);
  }

  return localDateString(new Date(), timeZone);
}

function resolveTaskDueTime(
  event: ExternalEventRow,
  timeZone: string,
): string | null {
  if (event.has_explicit_time === false) {
    return null;
  }

  const dueSource = event.ends_at || event.due_at;
  return dueSource ? localTimeString(new Date(dueSource), timeZone) : null;
}

async function loadNotificationStates(
  eventIds: string[],
): Promise<NotificationStateRow[]> {
  if (eventIds.length === 0) {
    return [];
  }

  const params = queryString({
    select: "id,event_id,alert_type,event_checksum,cooldown_until,notified_at",
    event_id: `in.(${eventIds.join(",")})`,
  });
  return await supabaseRequest<NotificationStateRow[]>(
    `notification_state?${params}`,
  );
}

async function recordNotification(
  eventId: string,
  alertType: string,
  eventChecksum: string,
  cooldownMinutes: number,
): Promise<void> {
  const now = new Date();
  const cooldownUntil = new Date(now.getTime() + cooldownMinutes * 60000);
  const params = queryString({ on_conflict: "event_id,alert_type" });
  await supabaseRequest(`notification_state?${params}`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      event_id: eventId,
      alert_type: alertType,
      event_checksum: eventChecksum,
      notified_at: now.toISOString(),
      cooldown_until: cooldownUntil.toISOString(),
    }]),
  });
}

function eventSignature(event: ExternalEventRow): string {
  return event.checksum ||
    `${event.due_at || ""}|${event.remind_at || ""}|${
      event.starts_at || ""
    }|${event.updated_at}`;
}

function telegramPhotoId(event: ExternalEventRow): string | null {
  const value = event.raw_payload_json?.telegram_photo_id;
  return typeof value === "string" && value.trim() ? value : null;
}

function truncateTelegramCaption(message: string): string {
  if (Array.from(message).length <= 1024) {
    return message;
  }

  const shortened = Array.from(message).slice(0, 997).join("")
    .replace(/<[^>]*$/g, "")
    .replace(/&[^;\s]{0,12}$/g, "")
    .trimEnd();
  return closeOpenTelegramTags(`${shortened}...`);
}

function closeOpenTelegramTags(html: string): string {
  const stack: string[] = [];
  const tagPattern = /<\/?(b|i)>/g;
  for (const match of html.matchAll(tagPattern)) {
    const [tag, name] = match;
    if (tag.startsWith("</")) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) {
        stack.splice(index, 1);
      }
    } else {
      stack.push(name);
    }
  }

  return `${html}${stack.reverse().map((name) => `</${name}>`).join("")}`;
}

function isTruthy(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
