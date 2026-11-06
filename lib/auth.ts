// Dashboard login (optional, enabled by DASHBOARD_PASSWORD). The cookie holds a SHA-256 digest
// of the password, so changing the password logs everyone out. Uses Web Crypto so it runs in
// both the edge middleware and Node route handlers.

export const AUTH_COOKIE = "fx_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export async function authToken(password: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`forex-ai-dashboard|${password}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Only allow redirects back to a path on this site.
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
