#!/usr/bin/env node
/**
 * Live probe against a deployed relay.
 *
 *   RELAY_URL="https://script.google.com/macros/s/<DEPLOY_ID>/exec" \
 *   RELAY_SECRET="..." npm run probe
 *
 *   node scripts/probe.mjs --health
 *   node scripts/probe.mjs --method getMe
 *   node scripts/probe.mjs --method sendMessage --data '{"chat_id":1,"text":"test"}'
 *
 * The relay always answers HTTP 200, so success is read from the "ok" field.
 * node/undici follows the Apps Script 302 redirect by default, which is exactly
 * what a real client has to do.
 */
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? true);
};

const url = process.env.RELAY_URL || flag('--url');
const secret = process.env.RELAY_SECRET || flag('--secret');

if (!url || !secret) {
  console.error('RELAY_URL and RELAY_SECRET are required (env vars or --url/--secret)');
  process.exit(2);
}

const method = flag('--health') ? '__health' : flag('--method', 'getMe');
const rawData = flag('--data');
const endpoint = `${url}?k=${encodeURIComponent(secret)}&m=${encodeURIComponent(method)}`;

const started = Date.now();
const options = { method: 'GET', redirect: 'follow' };
if (rawData) {
  options.method = 'POST';
  options.headers = { 'Content-Type': 'application/json' };
  options.body = rawData;
}

const response = await fetch(endpoint, options);
const text = await response.text();
const total = Date.now() - started;

let envelope;
try {
  envelope = JSON.parse(text);
} catch {
  console.error(`relay answered with non-JSON (HTTP ${response.status}):`);
  console.error(text.slice(0, 500));
  process.exitCode = 1;
  throw new Error('non-JSON answer from relay');
}

const summary = {
  http: response.status,
  roundtrip_ms: total,
  ok: envelope.ok,
  telegram_status: envelope.status,
  relay_ms: envelope.ms,
  method: envelope.method,
  error: envelope.error,
  data: envelope.data
};

console.log(JSON.stringify(summary, null, 2));

if (!envelope.ok) {
  // exitCode instead of process.exit(): on Windows Node 24 process.exit() while
  // undici still holds handles trips a libuv assertion during teardown
  process.exitCode = 1;
}
