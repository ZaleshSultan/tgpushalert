export function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getOptionalEnv(name: string, fallback = ""): string {
  return Deno.env.get(name) || fallback;
}

export function getTelegramToken(): string {
  return Deno.env.get("TELEGRAM_BOT_TOKEN") ||
    getRequiredEnv("TELEGRAM_TOKEN");
}

export function getAppTimezone(): string {
  return getOptionalEnv("APP_TIMEZONE", "Asia/Qyzylorda");
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function assertCronSecret(req: Request): void {
  const expected = getRequiredEnv("CRON_SECRET");
  const actual = req.headers.get("x-cron-secret");
  if (actual !== expected) {
    throw new HttpError(401, "Invalid cron secret");
  }
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function handleFunctionError(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  return jsonResponse({ ok: false, error: message }, status);
}
