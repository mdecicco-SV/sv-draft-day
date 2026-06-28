// Free shared-password gate (Vercel Edge Middleware) — the no-cost equivalent of
// Vercel's paid Password Protection. Runs on EVERY request (UI, /data, /api, fonts),
// so client intel can't be fetched directly without the password.
//
// Activate by setting SITE_PASSWORD in the project's env vars. Until it's set the
// site stays open (so we never lock ourselves out before a password exists).
// Browser shows a native login prompt; any username, the shared password.

export const config = { matcher: "/((?!_vercel).*)" };

export default function middleware(request) {
  const PASSWORD = process.env.SITE_PASSWORD;
  if (!PASSWORD) return; // not configured yet -> allow through

  const header = request.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try { decoded = atob(encoded); } catch (e) {}
    const pwd = decoded.slice(decoded.indexOf(":") + 1);
    if (pwd === PASSWORD) return; // authenticated -> continue
  }
  return new Response("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="SV Draft Day", charset="UTF-8"' },
  });
}
