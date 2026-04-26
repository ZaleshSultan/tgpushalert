import { isSupportedTimeZone, zonedTimeToUtc } from "./time.ts";

export interface IcsProperty {
  name: string;
  params: Record<string, string[]>;
  value: string;
}

export interface NormalizedIcsEvent {
  external_id: string;
  title: string;
  description: string | null;
  location: string | null;
  url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  due_at: string | null;
  checksum: string;
  raw_payload_json: Record<string, unknown>;
}

export interface ParseIcsOptions {
  defaultTimeZone?: string;
  deriveDueAtFromStart?: boolean;
}

export async function parseIcsCalendar(
  text: string,
  options: ParseIcsOptions = {},
): Promise<NormalizedIcsEvent[]> {
  const lines = unfoldLines(text);
  const events: IcsProperty[][] = [];
  const defaultTimeZone = resolveTimeZone(
    options.defaultTimeZone || "UTC",
    "UTC",
  );
  const deriveDueAtFromStart = options.deriveDueAtFromStart ?? true;
  let current: IcsProperty[] | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = [];
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        events.push(current);
      }
      current = null;
      continue;
    }
    if (!current) {
      continue;
    }

    const property = parsePropertyLine(line);
    if (property) {
      current.push(property);
    }
  }

  const normalized: NormalizedIcsEvent[] = [];
  for (const event of events) {
    const props = groupProperties(event);
    const uid = firstValue(props, "UID");
    const title = decodeText(
      firstValue(props, "SUMMARY") || "Событие без названия",
    );
    const description = nullableText(firstValue(props, "DESCRIPTION"));
    const location = nullableText(firstValue(props, "LOCATION"));
    const url = nullableText(firstValue(props, "URL"));
    const startsAt = parseIcsDateTime(
      firstProperty(props, "DTSTART"),
      defaultTimeZone,
    );
    const endsAt = parseIcsDateTime(
      firstProperty(props, "DTEND"),
      defaultTimeZone,
    );
    const explicitDueAt = parseIcsDateTime(
      firstProperty(props, "DUE"),
      defaultTimeZone,
    );
    const dueAt = explicitDueAt ||
      (deriveDueAtFromStart ? startsAt || endsAt : null);
    const rawPayload = serializeProperties(props);
    const stablePayload = {
      uid,
      title,
      description,
      location,
      url,
      starts_at: startsAt,
      ends_at: endsAt,
      due_at: dueAt,
    };
    const checksum = await sha256Hex(JSON.stringify(stablePayload));
    const fallbackId = await sha256Hex(
      `${title}|${startsAt || endsAt || checksum}`,
    );

    normalized.push({
      external_id: uid || fallbackId,
      title,
      description,
      location,
      url,
      starts_at: startsAt,
      ends_at: endsAt,
      due_at: dueAt,
      checksum,
      raw_payload_json: rawPayload,
    });
  }

  return normalized;
}

function unfoldLines(text: string): string[] {
  const physicalLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(
    "\n",
  );
  const lines: string[] = [];

  for (const line of physicalLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.trim()) {
      lines.push(line.trimEnd());
    }
  }

  return lines;
}

function parsePropertyLine(line: string): IcsProperty | null {
  const colonIndex = line.indexOf(":");
  if (colonIndex < 0) {
    return null;
  }

  const left = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const [nameRaw, ...paramParts] = left.split(";");
  const params: Record<string, string[]> = {};

  for (const part of paramParts) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex < 0) {
      params[part.toUpperCase()] = [];
      continue;
    }
    const key = part.slice(0, equalsIndex).toUpperCase();
    const values = part.slice(equalsIndex + 1)
      .split(",")
      .map((item) => item.replace(/^"|"$/g, ""));
    params[key] = values;
  }

  return {
    name: nameRaw.toUpperCase(),
    params,
    value,
  };
}

function groupProperties(
  properties: IcsProperty[],
): Record<string, IcsProperty[]> {
  const grouped: Record<string, IcsProperty[]> = {};
  for (const property of properties) {
    grouped[property.name] ||= [];
    grouped[property.name].push(property);
  }
  return grouped;
}

function firstProperty(
  props: Record<string, IcsProperty[]>,
  name: string,
): IcsProperty | undefined {
  return props[name]?.[0];
}

function firstValue(
  props: Record<string, IcsProperty[]>,
  name: string,
): string | null {
  return firstProperty(props, name)?.value || null;
}

function nullableText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const decoded = decodeText(value).trim();
  return decoded || null;
}

function decodeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseIcsDateTime(
  property: IcsProperty | undefined,
  defaultTimeZone: string,
): string | null {
  if (!property) {
    return null;
  }

  const value = property.value;
  const propertyTimeZone = property.params.TZID?.[0];
  const timeZone = resolveTimeZone(propertyTimeZone, defaultTimeZone);

  if (/^\d{8}$/.test(value)) {
    const year = value.slice(0, 4);
    const month = value.slice(4, 6);
    const day = value.slice(6, 8);
    return zonedTimeToUtc({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: 0,
      minute: 0,
      second: 0,
    }, timeZone).toISOString();
  }

  const utcMatch = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
  );
  if (utcMatch) {
    const [, year, month, day, hour, minute, second] = utcMatch;
    return new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    )).toISOString();
  }

  const floatingMatch = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,
  );
  if (floatingMatch) {
    const [, year, month, day, hour, minute, second] = floatingMatch;
    return zonedTimeToUtc({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    }, timeZone).toISOString();
  }

  const compactMinuteMatch = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/,
  );
  if (compactMinuteMatch) {
    const [, year, month, day, hour, minute] = compactMinuteMatch;
    return zonedTimeToUtc({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: 0,
    }, timeZone).toISOString();
  }

  const utcMinuteMatch = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/,
  );
  if (utcMinuteMatch) {
    const [, year, month, day, hour, minute] = utcMinuteMatch;
    return new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
    )).toISOString();
  }

  const offsetMatch = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-]\d{2})(\d{2})$/,
  );
  if (offsetMatch) {
    const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
      offsetMatch;
    return new Date(
      `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetHour}:${offsetMinute}`,
    ).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function resolveTimeZone(
  requested: string | undefined,
  fallback: string,
): string {
  const fallbackTimeZone = isSupportedTimeZone(fallback) ? fallback : "UTC";
  if (!requested) {
    return fallbackTimeZone;
  }

  for (const candidate of timeZoneCandidates(requested)) {
    if (isSupportedTimeZone(candidate)) {
      return candidate;
    }
  }

  console.warn(
    `Unknown ICS TZID "${requested}", falling back to ${fallbackTimeZone}`,
  );
  return fallbackTimeZone;
}

function timeZoneCandidates(value: string): string[] {
  const decoded = decodeText(value).trim().replace(/^"+|"+$/g, "");
  const upper = decoded.toUpperCase();
  const aliases: Record<string, string> = {
    UTC: "UTC",
    GMT: "UTC",
    Z: "UTC",
  };
  const candidates = new Set<string>();

  if (aliases[upper]) {
    candidates.add(aliases[upper]);
  }
  candidates.add(decoded);

  const normalized = decoded.replace(/^\/+/, "");
  candidates.add(normalized);

  const parts = normalized.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    candidates.add(parts.slice(index).join("/"));
  }

  return [...candidates].filter(Boolean);
}

function serializeProperties(
  props: Record<string, IcsProperty[]>,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(props)) {
    serialized[name] = values.map((property) => ({
      params: property.params,
      value: decodeText(property.value),
    }));
  }
  return serialized;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
