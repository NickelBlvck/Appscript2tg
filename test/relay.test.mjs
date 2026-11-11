import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRelay, event, json, form, makeResponse } from './harness.mjs';

const SECRET = 's3cr3t-relay-value';
const TOKEN = '111111:AAH-fake-token-for-tests';

function baseProps(extra = {}) {
  return { RELAY_SECRET: SECRET, BOT_TOKEN: TOKEN, ...extra };
}

test('rejects a wrong secret without touching the network', () => {
  const relay = loadRelay({ props: baseProps() });
  const { envelope } = relay.call('POST', event({ k: 'nope', m: 'sendMessage' }, json({ chat_id: 1 })));

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'unauthorized');
  assert.equal(relay.calls.length, 0);
});

test('rejects an empty secret the same way as a wrong one', () => {
  const relay = loadRelay({ props: baseProps() });
  const { envelope } = relay.call('POST', event({ m: 'sendMessage' }, json({ chat_id: 1 })));

  assert.equal(envelope.error, 'unauthorized');
  assert.equal(relay.calls.length, 0);
});

test('fails loudly when RELAY_SECRET is not configured', () => {
  const relay = loadRelay({ props: { BOT_TOKEN: TOKEN } });
  const { envelope } = relay.call('POST', event({ k: '', m: 'getMe' }));

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'not_configured');
});

test('requires the m parameter', () => {
  const relay = loadRelay({ props: baseProps() });
  const { envelope } = relay.call('GET', event({ k: SECRET }));

  assert.equal(envelope.error, 'method_required');
  assert.equal(relay.calls.length, 0);
});

test('POST relays JSON body verbatim to the right upstream URL', () => {
  const relay = loadRelay({ props: baseProps() });
  const payload = { chat_id: 203925128, text: 'проверка релея' };
  const { envelope, mime } = relay.call('POST', event({ k: SECRET, m: 'sendMessage' }, json(payload)));

  assert.equal(mime, 'application/json');
  assert.equal(relay.calls.length, 1);

  const [call] = relay.calls;
  assert.equal(call.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.contentType, 'application/json');
  assert.deepEqual(JSON.parse(call.opts.payload), payload);
  assert.equal(call.opts.muteHttpExceptions, true);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.status, 200);
  assert.equal(envelope.method, 'sendMessage');
});

test('form-urlencoded body keeps its content type and bytes', () => {
  const relay = loadRelay({ props: baseProps() });
  const body = 'chat_id=203925128&text=hello+world';
  relay.call('POST', event({ k: SECRET, m: 'sendMessage' }, form(body)));

  assert.equal(relay.calls[0].opts.contentType, 'application/x-www-form-urlencoded');
  assert.equal(relay.calls[0].opts.payload, body);
});

test('multipart boundary survives the relay', () => {
  const relay = loadRelay({ props: baseProps() });
  const type = 'multipart/form-data; boundary=----X';
  relay.call('POST', event({ k: SECRET, m: 'sendDocument' }, { type, contents: '--X--' }));

  assert.equal(relay.calls[0].opts.contentType, type);
});

test('GET builds the upstream query and drops relay-only params', () => {
  const relay = loadRelay({ props: baseProps() });
  const { envelope } = relay.call('GET', event({
    k: SECRET,
    m: 'sendMessage',
    chat_id: '203925128',
    text: 'привет мир'
  }));

  assert.equal(relay.calls.length, 1);
  assert.equal(
    relay.calls[0].url,
    `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=203925128&text=${encodeURIComponent('привет мир')}`
  );
  assert.equal(relay.calls[0].opts.payload, undefined);
  assert.equal(envelope.ok, true);
});

test('a Telegram error is passed through with its real status', () => {
  const relay = loadRelay({
    props: baseProps(),
    fetch: () => makeResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })
  });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'sendMessage' }, json({ chat_id: 1 })));

  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, 400);
  assert.equal(envelope.data.error_code, 400);
  assert.match(envelope.data.description, /chat not found/);
  assert.equal(relay.calls.length, 1, '4xx must not be retried');
});

test('write failures never break the relay and never lie about ok', () => {
  const relay = loadRelay({
    props: baseProps({ ALLOWED_METHODS: 'sendMessage, sendPhoto' })
  });

  const blocked = relay.call('POST', event({ k: SECRET, m: 'deleteWebhook' }, json({})));
  assert.equal(blocked.envelope.error, 'method_not_allowed');
  assert.equal(relay.calls.length, 0);

  const allowed = relay.call('POST', event({ k: SECRET, m: 'sendPhoto' }, json({ chat_id: 1, photo: 'x' })));
  assert.equal(allowed.envelope.ok, true);
});

test('retries once on 5xx and returns the second answer', () => {
  const relay = loadRelay({
    props: baseProps(),
    fetch: (url, opts, index) => (index === 0
      ? makeResponse(502, 'bad gateway')
      : makeResponse(200, { ok: true, result: { message_id: 7 } }))
  });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'sendMessage' }, json({ chat_id: 1 })));

  assert.equal(relay.calls.length, 2);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.result.message_id, 7);
});

test('RETRIES=0 disables the retry', () => {
  const relay = loadRelay({
    props: baseProps({ RETRIES: '0' }),
    fetch: () => makeResponse(503, 'unavailable')
  });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'getMe' }));

  assert.equal(relay.calls.length, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, 503);
});

test('a network exception becomes fetch_failed, not a crash', () => {
  const relay = loadRelay({
    props: baseProps({ RETRIES: '0' }),
    fetch: () => { throw new Error('DNS error: address not found'); }
  });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'sendMessage' }, json({ chat_id: 1 })));

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'fetch_failed');
  assert.match(envelope.message, /DNS error/);
});

test('bot alias from BOTS map wins over BOT_TOKEN', () => {
  const relay = loadRelay({
    props: {
      RELAY_SECRET: SECRET,
      BOT_TOKEN: TOKEN,
      BOTS: JSON.stringify({ lead: '999:LEADTOKEN', hermes: '888:HERMESTOKEN' })
    }
  });
  relay.call('POST', event({ k: SECRET, m: 'sendMessage', b: 'lead' }, json({ chat_id: 1 })));

  assert.match(relay.calls[0].url, /^https:\/\/api\.telegram\.org\/bot999:LEADTOKEN\//);
});

test('an unknown bot alias is refused', () => {
  const relay = loadRelay({ props: baseProps({ BOTS: '{"lead":"999:LEADTOKEN"}' }) });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'sendMessage', b: 'ghost' }, json({})));

  assert.equal(envelope.error, 'unknown_bot');
  assert.equal(relay.calls.length, 0);
});

test('corrupted BOTS json does not throw', () => {
  const relay = loadRelay({ props: baseProps({ BOTS: '{not json' }) });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'sendMessage', b: 'lead' }, json({})));

  assert.equal(envelope.error, 'unknown_bot');
});

test('__health answers without calling Telegram', () => {
  const relay = loadRelay({ props: baseProps({ BOTS: '{"lead":"999:X"}' }) });
  const { envelope } = relay.call('GET', event({ k: SECRET, m: '__health' }));

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.relay, 'tg-relay-gsheets');
  assert.deepEqual(envelope.data.bots, ['lead']);
  assert.equal(relay.calls.length, 0);
});

test('a non-JSON upstream body is returned as a string, not dropped', () => {
  const relay = loadRelay({
    props: baseProps(),
    fetch: () => makeResponse(200, '<html>cloudflare</html>')
  });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'getMe' }));

  assert.equal(envelope.ok, false, 'non-JSON with 200 must not claim success');
  assert.equal(envelope.data, '<html>cloudflare</html>');
});

test('every response carries the JSON mime type', () => {
  const relay = loadRelay({ props: baseProps() });
  const { mime } = relay.call('GET', event({ k: 'wrong', m: 'getMe' }));

  assert.equal(mime, 'application/json');
});

test('sheet logging appends one row when LOG_SHEET_ID is set', () => {
  const appended = [];
  const relay = loadRelay({
    props: baseProps({ LOG_SHEET_ID: 'sheet-1' }),
    sheet: {
      openById: () => ({
        getSheetByName: () => ({ appendRow: (row) => appended.push(row) }),
        insertSheet: () => { throw new Error('should reuse an existing sheet'); }
      })
    }
  });
  relay.call('POST', event({ k: SECRET, m: 'sendMessage' }, json({ chat_id: 1, text: 'hi' })));

  assert.equal(appended.length, 1);
  const row = appended[0];
  assert.equal(row[1], 'POST');
  assert.equal(row[2], 'sendMessage');
  assert.equal(row[4], 200);
  assert.equal(row[5], 'ok');
  // the Date comes from the VM realm, so instanceof Date of the host fails
  assert.equal(Object.prototype.toString.call(row[0]), '[object Date]');
  assert.ok(row[0].getTime() > 0);
  assert.equal(row[7], '', 'text preview stays off unless LOG_TEXT=1');
});

test('a broken spreadsheet never fails the relay', () => {
  const relay = loadRelay({
    props: baseProps({ LOG_SHEET_ID: 'sheet-1' }),
    sheet: { openById: () => { throw new Error('no permission'); } }
  });
  const { envelope } = relay.call('POST', event({ k: SECRET, m: 'sendMessage' }, json({ chat_id: 1 })));

  assert.equal(envelope.ok, true);
  assert.ok(relay.logs.some((line) => line.includes('relay log failed')));
});

test('constant-time comparison is correct on edge cases', () => {
  const relay = loadRelay({ props: baseProps() });
  const eq = relay.sandbox.RelayTestHooks.equalsConstantTime;

  assert.equal(eq('abc', 'abc'), true);
  assert.equal(eq('abc', 'ab'), false);
  assert.equal(eq('', ''), true);
  assert.equal(eq('abc', 'abd'), false);
  assert.equal(eq('длинный-секрет', 'длинный-секрет'), true);
  assert.equal(eq('длинный-секрет', 'длинный-секрет '), false);
});
