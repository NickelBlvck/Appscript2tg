/**
 * Telegram Bot API relay for Google Apps Script.
 *
 * Web app endpoint:
 *   https://script.google.com/macros/s/<DEPLOY_ID>/exec
 *
 * Usage:
 *   POST /exec?k=<RELAY_SECRET>&m=sendMessage[&b=<alias>]
 *        body: {"chat_id": 123, "text": "hi"}      (JSON, form-urlencoded or multipart)
 *        -> https://api.telegram.org/bot<token>/sendMessage
 *
 *   GET  /exec?k=<RELAY_SECRET>&m=getMe
 *   GET  /exec?k=<RELAY_SECRET>&m=__health         (relay itself, no call to Telegram)
 *
 * Script properties (Project Settings -> Script properties):
 *   RELAY_SECRET     required  shared secret taken from the query string
 *   BOT_TOKEN        default bot token
 *   BOTS             optional  JSON map {"lead":"123:AAA","hermes":"456:BBB"}, picked with &b=lead
 *   ALLOWED_METHODS  optional  comma-separated allowlist, empty = any method
 *   RETRIES          optional  "0" disables the single retry on 5xx / network error
 *   LOG_SHEET_ID     optional  spreadsheet id; one row appended per relayed call
 *   LOG_SHEET_NAME   optional  sheet name, default "relay_log"
 *   LOG_TEXT         optional  "1" appends a truncated text preview to the log
 *
 * IMPORTANT: Apps Script cannot set an HTTP status code. Every response is
 * 200 OK, so the client MUST read the "ok" field of the JSON envelope.
 *
 * IMPORTANT: Apps Script answers a web app call with a 302 redirect to
 * script.googleusercontent.com. Any client must follow redirects
 * (curl -L, python requests, node fetch, axios with maxRedirects>0).
 */

var ReservedParams_ = ['k', 'm', 'b'];

function doPost(e) {
  return handleRequest_(e, 'POST');
}

function doGet(e) {
  return handleRequest_(e, 'GET');
}

/**
 * Single entry point for both verbs.
 * @param {Object} e Apps Script event object
 * @param {string} verb 'POST' | 'GET'
 * @return {Object} ContentService.TextOutput
 */
function handleRequest_(e, verb) {
  var started = Date.now();
  var params = (e && e.parameter) || {};

  var secret = getProp_('RELAY_SECRET', '');
  if (!secret) {
    return respond_(failure_('not_configured', 'script property RELAY_SECRET is empty', started));
  }
  if (!equalsConstantTime_(String(params.k || ''), secret)) {
    return respond_(failure_('unauthorized', 'bad or missing secret in "k"', started));
  }

  var method = String(params.m || '').trim();
  if (!method) {
    return respond_(failure_('method_required', 'query parameter "m" is required', started));
  }

  if (method === '__health') {
    return respond_({
      ok: true,
      status: 200,
      method: method,
      ms: Date.now() - started,
      data: {
        relay: 'tg-relay-gsheets',
        bots: listBotAliases_(),
        has_default_token: Boolean(getProp_('BOT_TOKEN', '')),
        allowed_methods: getAllowedMethods_(),
        logging: Boolean(getProp_('LOG_SHEET_ID', ''))
      }
    });
  }

  var allowed = getAllowedMethods_();
  if (allowed.length && allowed.indexOf(method) === -1) {
    return respond_(failure_('method_not_allowed',
      'method "' + method + '" is not listed in ALLOWED_METHODS', started));
  }

  var resolved = resolveToken_(String(params.b || '').trim());
  if (!resolved.token) {
    return respond_(failure_(resolved.error,
      resolved.error === 'unknown_bot'
        ? 'no token for bot alias "' + params.b + '" in BOTS'
        : 'no BOT_TOKEN script property and no &b= alias given',
      started));
  }

  var request = buildRequest_(method, resolved.token, e, verb);

  var response = null;
  var lastError = null;
  var maxAttempts = getProp_('RETRIES', '1') === '0' ? 1 : 2;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = UrlFetchApp.fetch(request.url, {
        method: request.method,
        contentType: request.contentType,
        payload: request.payload,
        muteHttpExceptions: true,
        followRedirects: true
      });
      lastError = null;
      if (response.getResponseCode() < 500 || attempt === maxAttempts) {
        break;
      }
    } catch (err) {
      response = null;
      lastError = err;
      if (attempt === maxAttempts) {
        break;
      }
    }
    Utilities.sleep(250 * attempt);
  }

  if (!response) {
    var msg = lastError ? String(lastError.message || lastError) : 'no response from api.telegram.org';
    var failed = failure_('fetch_failed', msg, started);
    failed.method = method;
    logCall_(verb, method, resolved.alias, failed, '');
    return respond_(failed);
  }

  var status = response.getResponseCode();
  var text = response.getContentText();
  var data;
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    data = text;
  }

  var envelope = {
    ok: status === 200 && Boolean(data && data.ok === true),
    status: status,
    method: method,
    ms: Date.now() - started,
    data: data
  };

  logCall_(verb, method, resolved.alias, envelope, text);
  return respond_(envelope);
}

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */

/**
 * Builds the upstream request. The body is passed through untouched so that
 * JSON, form-urlencoded and multipart payloads keep working.
 */
function buildRequest_(method, token, e, verb) {
  var url = 'https://api.telegram.org/bot' + token + '/' + method;
  var extra = toQuery_((e && e.parameter) || {}, ReservedParams_);
  if (extra) {
    url += '?' + extra;
  }

  var contentType = 'application/x-www-form-urlencoded';
  var payload;

  if (verb === 'POST' && e && e.postData && e.postData.contents) {
    payload = e.postData.contents;
    contentType = e.postData.type || contentType;
  }

  return { url: url, method: verb, contentType: contentType, payload: payload };
}

/** Serialises query parameters except the relay's own ones. */
function toQuery_(params, skip) {
  var parts = [];
  for (var key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      continue;
    }
    if (skip.indexOf(key) !== -1) {
      continue;
    }
    var value = params[key];
    if (value === null || value === undefined) {
      continue;
    }
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return parts.join('&');
}

/** Resolves the bot token: &b=<alias> from BOTS, otherwise BOT_TOKEN. */
function resolveToken_(alias) {
  if (alias) {
    var raw = getProp_('BOTS', '');
    var bots = {};
    if (raw) {
      try {
        bots = JSON.parse(raw) || {};
      } catch (err) {
        bots = {};
      }
    }
    if (bots[alias]) {
      return { token: String(bots[alias]), alias: alias };
    }
    return { token: '', alias: alias, error: 'unknown_bot' };
  }
  var single = getProp_('BOT_TOKEN', '');
  return { token: single, alias: '', error: single ? '' : 'no_token' };
}

function listBotAliases_() {
  var raw = getProp_('BOTS', '');
  if (!raw) {
    return [];
  }
  try {
    return Object.keys(JSON.parse(raw) || {});
  } catch (err) {
    return [];
  }
}

function getAllowedMethods_() {
  var raw = getProp_('ALLOWED_METHODS', '');
  if (!raw) {
    return [];
  }
  var out = [];
  var parts = raw.split(',');
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim();
    if (name) {
      out.push(name);
    }
  }
  return out;
}

/** Length-independent comparison, to not leak the secret by timing. */
function equalsConstantTime_(a, b) {
  var max = Math.max(a.length, b.length);
  var diff = a.length ^ b.length;
  for (var i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function getProp_(name, fallback) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return value;
}

function failure_(error, message, started) {
  return { ok: false, status: 0, error: error, message: message, ms: Date.now() - started };
}

function respond_(envelope) {
  return ContentService
    .createTextOutput(JSON.stringify(envelope))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Appends one row per call when LOG_SHEET_ID is set. Never breaks the relay. */
function logCall_(verb, method, alias, envelope, rawBody) {
  var sheetId = getProp_('LOG_SHEET_ID', '');
  if (!sheetId) {
    return;
  }
  try {
    var name = getProp_('LOG_SHEET_NAME', 'relay_log');
    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
    var preview = '';
    if (getProp_('LOG_TEXT', '0') === '1' && rawBody) {
      preview = String(rawBody).replace(/\s+/g, ' ').slice(0, 120);
    }
    sheet.appendRow([
      new Date(),
      verb,
      method,
      alias || '-',
      envelope.status,
      envelope.ok ? 'ok' : (envelope.error || 'error'),
      envelope.ms,
      preview
    ]);
  } catch (err) {
    Logger.log('relay log failed: ' + err);
  }
}

/** Exposed for the local Node test harness only. */
var RelayTestHooks = {
  handleRequest: handleRequest_,
  buildRequest: buildRequest_,
  toQuery: toQuery_,
  resolveToken: resolveToken_,
  getAllowedMethods: getAllowedMethods_,
  equalsConstantTime: equalsConstantTime_,
  failure: failure_
};
