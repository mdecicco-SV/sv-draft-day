// Free shared-password gate (Vercel Edge Middleware) — password-only login, no username.
// Runs on EVERY request (UI, /data, /api, fonts) so client intel can't be fetched
// directly. Activate by setting SITE_PASSWORD; until set the site stays open.
// On correct password we set an httpOnly cookie (hash of the password) for 7 days.

export const config = { matcher: "/((?!_vercel).*)" };
const COOKIE = "sv_auth";
// PWA install assets must be fetchable before login (iOS/Chrome fetch the manifest,
// icons and service worker outside the page's cookie context). Nothing sensitive here.
const OPEN_PATHS = /^\/(manifest\.webmanifest|sw\.js|favicon\.svg|icons\/[^/]+)$/;
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SV Draft Day</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f3f1;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#141414}
.card{background:#fff;border:1px solid #e3e3e3;border-top:4px solid #ff2a22;border-radius:14px;padding:30px 28px;
width:300px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.05)}
.mark{color:#ff2a22;font-weight:900;font-size:34px;line-height:1;letter-spacing:1px}
.ttl{font-weight:900;font-size:18px;margin-top:2px}.sub{color:#6b6b6b;font-size:13px;margin:6px 0 18px}
input{width:100%;padding:11px 12px;border:1px solid #e3e3e3;border-radius:8px;font-size:15px}
button{width:100%;margin-top:10px;padding:11px;border:0;border-radius:8px;background:#ff2a22;color:#fff;
font-weight:800;font-size:15px;cursor:pointer}button:hover{background:#e0241d}
.err{color:#ff2a22;font-size:12px;font-weight:700;margin-top:10px;${error ? "" : "display:none"}}
</style></head><body><form class="card" method="POST" action="/__login">
<div class="mark">SV</div><div class="ttl">Draft Day</div><div class="sub">Enter the team password</div>
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="Password">
<button type="submit">Enter</button><div class="err">Incorrect password — try again</div>
</form></body></html>`;
}

export default async function middleware(request) {
  const PASSWORD = process.env.SITE_PASSWORD;
  if (!PASSWORD) return; // not configured -> open

  const url = new URL(request.url);
  if (OPEN_PATHS.test(url.pathname)) return; // PWA install assets stay open
  // X-watcher userscript posts cross-origin with its own shared key (no login cookie);
  // the function re-validates the same key. Wrong/absent key falls through to the gate.
  if (url.pathname === "/api/xlead-ingest" && process.env.DD_INGEST_KEY
      && request.headers.get("x-dd-key") === process.env.DD_INGEST_KEY) return;

  const expected = await sha(PASSWORD);

  if (request.method === "POST" && url.pathname === "/__login") {
    const form = await request.formData();
    if ((form.get("password") || "") === PASSWORD) {
      return new Response(null, { status: 303, headers: {
        "Location": "/",
        "Set-Cookie": `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
      }});
    }
    return new Response(loginPage(true), { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sv_auth=([a-f0-9]+)/);
  if (m && m[1] === expected) return; // authenticated

  return new Response(loginPage(false), { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
