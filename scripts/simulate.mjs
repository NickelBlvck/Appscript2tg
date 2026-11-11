#!/usr/bin/env node
/**
 * Local stand-in for the deployed Apps Script web app.
 *
 * Runs the real src/Code.gs logic behind an HTTP server that reproduces the two
 * Apps Script quirks that break clients:
 *   1. every call answers 302 to a separate URL that carries the body
 *   2. the final response is always HTTP 200, success lives in the JSON envelope
 *
 *   node scripts/simulate.mjs
 *   RELAY_URL=http://127.0.0.1:8788/exec RELAY_SECRET=sim-secret npm run probe
 *
 * Upstream is canned (no traffic to Telegram). To make it return something else:
 *   SIM_UPSTREAM_JSON='{"ok":false,"error_code":400,"description":"chat not found"}' \
 *   SIM_UPSTREAM_STATUS=400 node scripts/simulate.mjs
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadRelay, makeResponse } from '../test/harness.mjs';

const PORT = Number(process.env.SIM_PORT || 8788);
const SECRET = process.env.SIM_SECRET || 'sim-secret';
const TOKEN = process.env.SIM_TOKEN || '000000:SIMULATED-TOKEN';
const UPSTREAM_STATUS = Number(process.env.SIM_UPSTREAM_STATUS || 200);
const UPSTREAM_JSON = process.env.SIM_UPSTREAM_JSON
  || '{"ok":true,"result":{"id":1,"is_bot":true,"username":"sim_bot"}}';

const relay = loadRelay({
  props: {
    RELAY_SECRET: SECRET,
    BOT_TOKEN: TOKEN,
    BOTS: process.env.SIM_BOTS || '{"sim":"000000:SIMULATED-TOKEN"}',
    ALLOWED_METHODS: process.env.SIM_ALLOWED || ''
  },
  fetch: (url) => {
    console.log(`  upstream -> ${url.replace(/bot[^/]+/, 'bot<redacted>')}`);
    return makeResponse(UPSTREAM_STATUS, UPSTREAM_JSON);
  }
});

const pending = new Map();

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

function toEvent(req, query, body) {
  const parameter = Object.fromEntries(query.entries());
  const e = { parameter, parameters: parameter };
  if (body && req.method === 'POST') {
    e.postData = {
      contents: body,
      type: req.headers['content-type'] || 'application/x-www-form-urlencoded'
    };
  }
  return e;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.startsWith('/result/')) {
    const id = url.pathname.slice('/result/'.length);
    const payload = pending.get(id);
    pending.delete(id);
    if (!payload) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unknown_result_id' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(payload);
    return;
  }

  if (url.pathname !== '/exec') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found, use /exec');
    return;
  }

  const body = await readBody(req);
  const e = toEvent(req, url.searchParams, body);
  const verb = req.method === 'GET' ? 'GET' : 'POST';
  const output = verb === 'GET' ? relay.sandbox.doGet(e) : relay.sandbox.doPost(e);

  const id = randomUUID();
  pending.set(id, output.getContent());

  console.log(`${verb} ${url.search.replace(/k=[^&]*/, 'k=<redacted>')} -> 302 /result/${id.slice(0, 8)}`);

  res.writeHead(302, { Location: `/result/${id}`, 'Content-Type': 'text/html' });
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`simulated Apps Script listening on http://127.0.0.1:${PORT}/exec`);
  console.log(`secret=${SECRET}  upstream_status=${UPSTREAM_STATUS}`);
});
