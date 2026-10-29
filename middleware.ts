import { NextResponse, type NextRequest } from "next/server";

// Optional password for the dashboard: set DASHBOARD_PASSWORD (any username works).
// The cron endpoint has its own CRON_SECRET check and is excluded.
export function middleware(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="forex-ai"' },
  });
}

export const config = { matcher: ["/((?!api/cron|_next/static|_next/image|favicon.ico).*)"] };
