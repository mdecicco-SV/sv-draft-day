/**
 * SV Draft Day — X Account Capture — v1.0.0
 *
 * SELF-CONTAINED Apps Script: captures every original post from 8 draft
 * insider accounts over the 48-hour draft weekend window, into a Google
 * Sheet. No dependencies on any other script file.
 *
 *   Accounts: @OverSlot_ @CarlosACollazo @jimcallisMLB @JonathanMayo
 *             @JeffPassan @kileymcd @JonHeyman @JoeDoyleMiLB
 *   Window:   Sat 2026-07-11 00:00 ET → Mon 2026-07-13 00:00 ET (48h)
 *
 * HOW IT POLLS. One GET to X API v2 recent search per run:
 *   /2/tweets/search/recent?query=(from:a OR from:b ...) -is:retweet
 * with start_time pinned to max(window start, last-poll overlap). A
 * time-driven trigger fires every 15 minutes; runs outside the window are
 * no-ops (zero API calls). Dedupe is by tweet URL against the sheet, so the
 * overlap between polls never double-writes.
 *
 * SETUP (once, any time before Saturday):
 *   1. Create/choose a Google Sheet for output. Copy its ID from the URL.
 *   2. In the Apps Script editor: Project Settings → Script Properties, add:
 *        X_BEARER_TOKEN   — X API v2 bearer token
 *        SHEET_ID         — the output spreadsheet ID
 *        SLACK_ALERT_WEBHOOK_URL — (optional) Slack incoming webhook for
 *                           failure alerts; omit to log-only
 *   3. Run testDraftDayCapture() from the editor — does one live query
 *      (last 60 min, ignores the window), logs results, writes nothing.
 *      Approve the authorization prompts on first run.
 *   4. Run setupDraftDay() — installs the 15-minute trigger. Installing
 *      early is free; it sleeps until the window opens.
 *
 * After the window closes, the first post-window run writes a final note,
 * removes its own trigger, and the capture is done. Run teardownDraftDay()
 * only if you want to stop early.
 *
 * OUTPUT COLUMNS (tab "DraftDay_Feed", created automatically):
 *   date | source | matched_query | handle | text | url | ingested_at | posted
 */

// ============ CONFIG ============
const DD_HANDLES = [
  'OverSlot_',
  'CarlosACollazo',
  'jimcallisMLB',
  'JonathanMayo',
  'JeffPassan',
  'kileymcd',
  'JonHeyman',
  'JoeDoyleMiLB'
];

// 48-hour capture window, US Eastern (EDT = UTC-4 in July).
const DD_WINDOW_START = new Date('2026-07-11T00:00:00-04:00');
const DD_WINDOW_END = new Date('2026-07-13T00:00:00-04:00');

const DD_SHEET_NAME = 'DraftDay_Feed';
const DD_MAX_RESULTS = 100;          // per request (endpoint max)
const DD_MAX_PAGES_PER_RUN = 5;      // safety cap; 8 accounts rarely need >1
const DD_OVERLAP_MINUTES = 30;       // re-query overlap so a failed run loses nothing
const DD_INCLUDE_REPLIES = true;     // insiders often break news in reply threads
const DD_PAUSE_MINUTES = 60;         // back-off after 401/403/429

// -is:retweet drops pure RTs (duplicates of the original post). Quote tweets
// and originals always come through. Replies controlled by the flag above.
const DD_QUERY =
  `(${DD_HANDLES.map(h => `from:${h}`).join(' OR ')}) -is:retweet` +
  (DD_INCLUDE_REPLIES ? '' : ' -is:reply');

// Script-property keys
const DD_PROP_LAST_POLL = 'DD_LAST_POLL_ISO';
const DD_PROP_PAUSED_UNTIL = 'DD_PAUSED_UNTIL';
const DD_PROP_DONE = 'DD_CAPTURE_DONE';

// ============ ENTRY POINT (trigger target) ============
function fetchDraftDay() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();

  // --- window guard ---
  if (now < DD_WINDOW_START) {
    Logger.log(`DraftDay: before window (opens ${DD_WINDOW_START.toISOString()}), no-op.`);
    return;
  }
  if (now.getTime() > DD_WINDOW_END.getTime() + DD_OVERLAP_MINUTES * 60000) {
    // One overlap-length grace period past the end so the final poll still
    // sweeps up posts from the window's last minutes, then self-teardown.
    if (props.getProperty(DD_PROP_DONE) !== 'TRUE') {
      props.setProperty(DD_PROP_DONE, 'TRUE');
      teardownDraftDay();
      ddAlert('INFO', 'Draft Day capture complete',
        `48h window closed (${DD_WINDOW_START.toISOString()} → ${DD_WINDOW_END.toISOString()}). ` +
        `Trigger removed. Rows are in the '${DD_SHEET_NAME}' tab.`);
    }
    return;
  }

  // --- pause guard (auth/rate-limit back-off) ---
  const pausedUntil = props.getProperty(DD_PROP_PAUSED_UNTIL);
  if (pausedUntil && now.getTime() < parseInt(pausedUntil, 10)) {
    Logger.log(`DraftDay: paused until ${new Date(parseInt(pausedUntil, 10)).toISOString()}, skipping.`);
    return;
  }

  // start_time: window start on the first run, then last poll minus overlap.
  // Dedupe makes the overlap harmless; it exists so one failed run never
  // leaves a gap.
  const lastPoll = props.getProperty(DD_PROP_LAST_POLL);
  let startTime = DD_WINDOW_START;
  if (lastPoll) {
    const overlapped = new Date(new Date(lastPoll).getTime() - DD_OVERLAP_MINUTES * 60000);
    if (overlapped > startTime) startTime = overlapped;
  }

  const result = ddSearch(startTime, DD_MAX_PAGES_PER_RUN, true);
  if (result.ok) {
    props.setProperty(DD_PROP_LAST_POLL, now.toISOString());
    props.deleteProperty(DD_PROP_PAUSED_UNTIL);
  }
  Logger.log(`DraftDay: api=${result.apiTotal}, new=${result.newCount}`);
}

// ============ CORE SEARCH ============
// Runs the search/recent query from startTime, optionally writing rows.
// Returns { ok, apiTotal, newCount }.
function ddSearch(startTime, maxPages, writeToSheet) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('X_BEARER_TOKEN');
  if (!token) {
    ddAlert('CRITICAL', 'Draft Day capture misconfigured',
      'Script property X_BEARER_TOKEN is not set. No data can be fetched.');
    return { ok: false, apiTotal: 0, newCount: 0 };
  }

  const sheet = writeToSheet ? ddGetSheet() : null;
  const existingUrls = sheet ? ddGetExistingUrls(sheet) : new Set();
  const rows = [];
  let apiTotal = 0;
  let nextToken = null;
  const ingestedAt = new Date().toISOString();

  for (let page = 1; page <= maxPages; page++) {
    let url = 'https://api.twitter.com/2/tweets/search/recent' +
      `?query=${encodeURIComponent(DD_QUERY)}` +
      `&max_results=${DD_MAX_RESULTS}` +
      `&start_time=${startTime.toISOString()}` +
      '&tweet.fields=created_at,author_id' +
      '&expansions=author_id&user.fields=username';
    if (nextToken) url += `&next_token=${nextToken}`;

    let res;
    try {
      res = UrlFetchApp.fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log(`DraftDay page ${page} threw: ${e.message}`);
      ddAlert('WARNING', 'Draft Day fetch threw exception', `[page ${page}] ${e.message}`);
      break;
    }

    const code = res.getResponseCode();
    if (code !== 200) {
      const body = res.getContentText();
      Logger.log(`DraftDay page ${page} failed: ${code} ${body.slice(0, 300)}`);
      ddAlertForHttp(code, body, page);
      if (code === 401 || code === 402 || code === 403 || code === 429) {
        props.setProperty(DD_PROP_PAUSED_UNTIL,
          (Date.now() + DD_PAUSE_MINUTES * 60000).toString());
        Logger.log(`DraftDay: pausing ${DD_PAUSE_MINUTES} min after HTTP ${code}.`);
      }
      break;
    }

    const data = JSON.parse(res.getContentText());
    if (!data.data || data.data.length === 0) break;
    apiTotal += data.data.length;

    const users = {};
    if (data.includes && data.includes.users) {
      data.includes.users.forEach(u => { users[u.id] = u.username; });
    }

    data.data.forEach(t => {
      const handle = users[t.author_id] || 'unknown';
      const tweetUrl = `https://x.com/${handle}/status/${t.id}`;
      if (existingUrls.has(tweetUrl)) return;
      existingUrls.add(tweetUrl);
      rows.push([
        t.created_at, 'x', 'draftday', `@${handle}`,
        t.text || '', tweetUrl, ingestedAt, 'FALSE'
      ]);
    });

    nextToken = data.meta && data.meta.next_token;
    if (!nextToken) break;
    Utilities.sleep(1000);
  }

  if (sheet && rows.length > 0) {
    rows.reverse(); // API is newest-first; append oldest-first for a readable sheet
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
  }
  return { ok: true, apiTotal, newCount: rows.length };
}

// ============ SHEET HELPERS ============
function ddGetSheet() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  if (!sheetId) throw new Error('Script property SHEET_ID is not set.');
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName(DD_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DD_SHEET_NAME);
    sheet.getRange(1, 1, 1, 8).setValues([[
      'date', 'source', 'matched_query', 'handle', 'text', 'url', 'ingested_at', 'posted'
    ]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ddGetExistingUrls(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return new Set();
  const urls = sheet.getRange(2, 6, last - 1, 1).getValues().flat();
  return new Set(urls.map(u => (u || '').toString()));
}

// ============ ALERTING (self-contained) ============
function ddAlert(severity, title, message) {
  const webhookUrl = PropertiesService.getScriptProperties()
    .getProperty('SLACK_ALERT_WEBHOOK_URL');
  if (!webhookUrl) {
    Logger.log(`[ALERT-NOWEBHOOK ${severity}] ${title}: ${message}`);
    return;
  }
  const prefix = severity === 'CRITICAL' ? '🚨🚨🚨'
    : severity === 'WARNING' ? '⚠️' : 'ℹ️';
  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: `${prefix} *${severity}: ${title}*\n${message}` }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log(`Alert webhook failed: ${e.message}`);
  }
}

function ddAlertForHttp(code, body, page) {
  if (code === 401) {
    ddAlert('CRITICAL', 'Draft Day X auth failure',
      `[page ${page}] HTTP 401 — bearer token rejected. Check X_BEARER_TOKEN.`);
  } else if (code === 429) {
    ddAlert('CRITICAL', 'Draft Day X rate limit / budget cap',
      `[page ${page}] HTTP 429 — rate limit or monthly read cap hit. Paused ${DD_PAUSE_MINUTES} min.`);
  } else if (code === 403 || code === 402) {
    ddAlert('CRITICAL', 'Draft Day X access forbidden',
      `[page ${page}] HTTP ${code} — plan/access issue. Body: ${body.slice(0, 300)}`);
  } else if (code >= 500) {
    ddAlert('WARNING', 'Draft Day X server error',
      `[page ${page}] HTTP ${code} — likely transient, will retry next run.`);
  } else {
    ddAlert('WARNING', 'Draft Day X unexpected response',
      `[page ${page}] HTTP ${code}. Body: ${body.slice(0, 300)}`);
  }
}

// ============ TRIGGER MANAGEMENT ============
function setupDraftDay() {
  teardownDraftDay(); // idempotent — never double-install
  ScriptApp.newTrigger('fetchDraftDay').timeBased().everyMinutes(15).create();
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(DD_PROP_DONE);
  props.deleteProperty(DD_PROP_LAST_POLL);
  props.deleteProperty(DD_PROP_PAUSED_UNTIL);
  Logger.log(`DraftDay: 15-min trigger installed. Window ${DD_WINDOW_START.toISOString()} → ` +
    `${DD_WINDOW_END.toISOString()}; runs outside it are no-ops.`);
  Logger.log(`DraftDay query (${DD_QUERY.length} chars): ${DD_QUERY}`);
}

function teardownDraftDay() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (tr.getHandlerFunction() === 'fetchDraftDay') {
      ScriptApp.deleteTrigger(tr);
      removed++;
    }
  });
  Logger.log(`DraftDay: removed ${removed} trigger(s).`);
}

// ============ TEST ============
// One live query over the last 60 minutes, ignoring the window. Logs what it
// finds, writes NOTHING. Run from the editor to verify token + query before
// Saturday. (A quiet hour returning 0 posts is still a pass — look for HTTP
// 200 in the log.)
function testDraftDayCapture() {
  Logger.log(`Query (${DD_QUERY.length} chars): ${DD_QUERY}`);
  const result = ddSearch(new Date(Date.now() - 60 * 60000), 1, false);
  Logger.log(result.ok
    ? `Test OK — ${result.apiTotal} post(s) from the tracked accounts in the last hour. ` +
      'Run setupDraftDay() to arm.'
    : 'Test FAILED — see log/alert above.');
}
