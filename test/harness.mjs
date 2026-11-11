/**
 * Loads src/Code.gs into a Node VM sandbox with stand-ins for the Apps Script
 * globals (PropertiesService, UrlFetchApp, ContentService, Utilities, Logger,
 * SpreadsheetApp). This lets the relay logic be unit tested locally, without
 * deploying anything to Google.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_PATH = path.join(HERE, '..', 'src', 'Code.gs');

/** Fake HTTPResponse, shaped like the one UrlFetchApp returns. */
export function makeResponse(code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    getResponseCode: () => code,
    getContentText: () => text
  };
}

/**
 * @param {object} options
 * @param {object} [options.props]  script properties (name -> string)
 * @param {function} [options.fetch] (url, opts, callIndex) => response
 * @param {object} [options.sheet]  {openById: fn} override for SpreadsheetApp
 */
export function loadRelay(options = {}) {
  const props = options.props || {};
  const calls = [];
  const logs = [];
  const rows = [];

  const defaultFetch = () => makeResponse(200, { ok: true, result: { id: 42, is_bot: true } });

  const sheetApi = options.sheet || {
    openById: () => {
      throw new Error('no spreadsheet configured in this test');
    }
  };

  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (name) => (Object.prototype.hasOwnProperty.call(props, name) ? props[name] : null)
      })
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        const index = calls.length;
        calls.push({ url, opts });
        const impl = options.fetch || defaultFetch;
        return impl(url, opts, index);
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => {
        const output = {
          _text: text,
          _mime: null,
          setMimeType(mime) {
            output._mime = mime;
            return output;
          },
          getContent() {
            return output._text;
          }
        };
        return output;
      }
    },
    SpreadsheetApp: {
      openById: (id) => {
        const spreadsheet = sheetApi.openById(id);
        return {
          getSheetByName: (name) => spreadsheet.getSheetByName(name),
          insertSheet: (name) => spreadsheet.insertSheet(name)
        };
      }
    },
    Utilities: { sleep: () => {} },
    Logger: { log: (message) => logs.push(String(message)) }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), sandbox, { filename: 'Code.gs' });

  /** Runs a request through the real doPost/doGet and returns parsed JSON. */
  function call(verb, event) {
    const handler = verb === 'GET' ? sandbox.doGet : sandbox.doPost;
    const output = handler(event);
    return { envelope: JSON.parse(output.getContent()), mime: output._mime, output };
  }

  return { sandbox, calls, logs, rows, call };
}

/** Builds an Apps Script event object. */
export function event(parameters = {}, postData = null) {
  const e = { parameter: parameters, parameters };
  if (postData) {
    e.postData = postData;
  }
  return e;
}

export const json = (value) => ({ type: 'application/json', contents: JSON.stringify(value) });
export const form = (text) => ({ type: 'application/x-www-form-urlencoded', contents: text });
