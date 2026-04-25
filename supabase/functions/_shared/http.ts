export interface FetchWithTimeoutOptions extends RequestInit {
  label?: string;
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { label = "request", timeoutMs = 20_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchTextWithTimeout(
  input: string | URL | Request,
  options: FetchWithTimeoutOptions = {},
): Promise<string> {
  const label = options.label || "request";
  const response = await fetchWithTimeout(input, options);
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `${label} failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return await response.text();
}

export async function fetchJsonWithTimeout<T>(
  input: string | URL | Request,
  options: FetchWithTimeoutOptions = {},
): Promise<T> {
  const label = options.label || "request";
  const text = await fetchTextWithTimeout(input, options);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}`);
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, " ").trim().slice(0, 500);
  } catch {
    return "";
  }
}
