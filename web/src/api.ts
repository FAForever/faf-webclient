// Every request goes to this site's own /api routes (server.js), which proxies
// an allowlisted set of read-only upstreams and caches them for all visitors.

import { fafUrl } from "./hosts";

export class ApiError extends Error {
  /** `code` is set by server.js for failures it explains, e.g. "service-login-missing". */
  constructor(public status: number, message: string, public code: string | null = null) {
    super(message);
  }
}

async function fetchOk(path: string, accept: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(path, { signal, headers: { Accept: accept } });
  if (!res.ok) {
    let code: string | null = null;
    try {
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code === "string") code = body.code;
    } catch {
      // Not JSON; the status says enough.
    }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, code);
  }
  return res;
}

export async function getJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  return (await (await fetchOk(path, "application/json", signal)).json()) as T;
}

/** For the upstreams that are not JSON: the changelog's page and notes. */
export async function getText(path: string, signal?: AbortSignal): Promise<string> {
  return (await fetchOk(path, "text/plain, text/html, */*", signal)).text();
}

/** First defined, non-empty value among several possible field names. */
export function pick<T = unknown>(obj: Record<string, unknown> | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value as T;
  }
  return undefined;
}

// --- FAF JSON:API -----------------------------------------------------------

export interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] | null }>;
}

export interface JsonApiDocument {
  data?: JsonApiResource[];
  included?: JsonApiResource[];
  meta?: { page?: { totalPages?: number; totalRecords?: number } };
}

export function fafPath(resource: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `/api/faf/${resource}${query ? `?${query}` : ""}`;
}

/** Resolve a to-one relationship of `resource` from the document's `included` list. */
export function related(doc: JsonApiDocument, resource: JsonApiResource, name: string): JsonApiResource | undefined {
  const ref = resource.relationships?.[name]?.data;
  if (!ref || Array.isArray(ref)) return undefined;
  return doc.included?.find((item) => item.type === ref.type && item.id === ref.id);
}

export function mapPreviewUrl(folderName: string, size: "small" | "large" = "small"): string {
  return `${fafUrl("content")}/maps/previews/${size}/${encodeURIComponent(folderName)}.png`;
}

export function formatDate(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function timeAgo(value: unknown): string {
  if (typeof value !== "string") return "";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}
