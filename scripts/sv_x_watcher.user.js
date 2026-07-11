// ==UserScript==
// @name         SV Draft Day — X watcher
// @namespace    sv-draft-day
// @version      1.0
// @description  Reads new tweets out of the open X Pro column / timeline and feeds them to the SV Draft Day lead ladder (~5-15s post-to-tile)
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      sv-draft-day.vercel.app
// @run-at       document-idle
// ==/UserScript==

// SETUP (one time, draft-day):
//   1. Install Tampermonkey/Violentmonkey in the browser holding the live X window.
//   2. Paste this script in; fill KEY below with the DD_INGEST_KEY Vercel env value.
//   3. Keep the X Pro column (or list timeline) as a VISIBLE foreground window —
//      background tabs throttle timers to ~1/min and quietly kill the latency win.
//   4. Run the window on a secondary X account (automated reading is ToS-gray).
// The console header dot goes green while heartbeats arrive; if this script dies,
// the room falls back to the paste lane and the 15-min sheet bot — nothing breaks.

(function () {
  "use strict";
  const ENDPOINT = "https://sv-draft-day.vercel.app/api/xlead-ingest";
  const KEY = "PASTE_DD_INGEST_KEY_HERE";

  const seen = new Set();
  let queue = [];

  const post = (body) => new Promise((resolve) => GM_xmlhttpRequest({
    method: "POST", url: ENDPOINT,
    headers: { "Content-Type": "application/json", "x-dd-key": KEY },
    data: JSON.stringify(body),
    onload: resolve, onerror: resolve, ontimeout: resolve,
  }));

  const tweetUrl = (a) => {
    const link = a.querySelector('a[href*="/status/"]');
    return link ? link.href.split("?")[0] : null;
  };

  function harvest(send) {
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      try {
        const url = tweetUrl(a);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        if (!send) continue;   // first pass: everything already on screen is old news
        const textEl = a.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText.trim() : "";
        if (!text) continue;
        const m = url.match(/(?:x|twitter)\.com\/([^/]+)\/status\//);
        const timeEl = a.querySelector("time");
        queue.push({ handle: m ? m[1] : "?", text, url,
          at: timeEl ? timeEl.getAttribute("datetime") : new Date().toISOString() });
      } catch (e) {}
    }
    // normal x.com timelines hold fresh tweets behind a "Show N posts" pill — click it.
    // (X Pro columns stream on their own; the selector just never matches there.)
    if (send) for (const el of document.querySelectorAll('[data-testid="pillLabel"]')) {
      try { el.closest('[role="button"], button')?.click(); } catch (e) {}
    }
  }

  harvest(false);                       // baseline: don't replay the visible backlog
  setInterval(() => harvest(true), 3000);
  setInterval(() => {
    if (!queue.length) return;
    const batch = queue.splice(0, 20);
    post({ tweets: batch });
  }, 3000);
  setInterval(() => post({ hb: true }), 30000);   // heartbeat → green dot in the console
  post({ hb: true });
})();
