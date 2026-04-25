import {
  assertCronSecret,
  getAppTimezone,
  getOptionalEnv,
  handleFunctionError,
  jsonResponse,
} from "../_shared/env.ts";
import {
  chooseAlertType,
  eventKeyboard,
  formatAlertMessage,
} from "../_shared/events.ts";
import {
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
    const events = await supabaseRequest<ExternalEventRow[]>(
      `external_events?${eventParams}`,
    );

    const mutedParams = queryString({
      select: "*",
      item_kind: "eq.event",
      muted_until: `gt.${now.toISOString()}`,
    });
    const mutedItems = await supabaseRequest<MutedItemRow[]>(
      `muted_items?${mutedParams}`,
    );
    const mutedEventIds = new Set(mutedItems.map((item) => item.item_ref));

    const candidates = events
      .map((event) => ({ event, alertType: chooseAlertType(event, now) }))
      .filter((item): item is { event: ExternalEventRow; alertType: string } =>
        Boolean(item.alertType)
      )
      .filter((item) => !mutedEventIds.has(item.event.id));

    const states = await loadNotificationStates(
      candidates.map((item) => item.event.id),
    );
    const stateByKey = new Map(
      states.map((state) => [`${state.event_id}:${state.alert_type}`, state]),
    );

    let sent = 0;
    for (const candidate of candidates) {
      const key = `${candidate.event.id}:${candidate.alertType}`;
      const signature = eventSignature(candidate.event);
      const state = stateByKey.get(key);
      if (state?.event_checksum === signature) {
        continue;
      }

      const message = formatAlertMessage(candidate.event, timeZone);
      const keyboard = eventKeyboard(candidate.event.id);
      const photoId = telegramPhotoId(candidate.event);
      if (photoId) {
        await sendTelegramPhoto(
          chatId,
          photoId,
          truncateTelegramCaption(message),
          keyboard,
        );
      } else {
        await sendTelegramMessage(chatId, message, keyboard);
      }
      await recordNotification(
        candidate.event.id,
        candidate.alertType,
        signature,
        cooldownMinutes,
      );
      stateByKey.set(key, {
        id: state?.id || "",
        event_id: candidate.event.id,
        alert_type: candidate.alertType,
        event_checksum: signature,
        notified_at: now.toISOString(),
        cooldown_until: null,
      });
      sent += 1;
    }

    return jsonResponse({
      ok: true,
      candidates: candidates.length,
      sent,
    });
  } catch (error) {
    return handleFunctionError(error);
  }
});

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
