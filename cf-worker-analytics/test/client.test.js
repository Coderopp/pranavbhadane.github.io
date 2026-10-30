// Runs the real ../../analytics.js in a stubbed browser environment and checks
// that what it sends passes the Worker's own validator.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { validateEvent } from '../src/validate.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../../analytics.js', import.meta.url)), 'utf8');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

function browser({ href = 'https://coderopp.github.io/pranavbhadane.github.io/career.html?utm_source=linkedin&email=x@y.z#top', referrer = 'https://www.linkedin.com/feed/?trk=abc', session = memoryStorage(), local = memoryStorage(), navigatorExtra = {}, noSessionStorage = false, fetchImpl } = {}) {
  const sent = [];
  const listeners = {};
  const url = new URL(href);
  const doc = {
    referrer,
    visibilityState: 'visible',
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    },
  };
  const win = {
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    screen: { width: 1440, height: 900 },
    crypto: globalThis.crypto,
    AbortController,
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    },
    fetch:
      fetchImpl ||
      ((endpoint, init) => {
        sent.push({ endpoint, init, body: JSON.parse(init.body), via: 'fetch' });
        return Promise.resolve(new Response('{}', { status: 202 }));
      }),
  };
  if (!noSessionStorage) win.sessionStorage = session;
  else Object.defineProperty(win, 'sessionStorage', { get() { throw new Error('SecurityError'); } });
  win.localStorage = local;
  const nav = {
    language: 'en-IN',
    webdriver: false,
    sendBeacon: (endpoint, blob) => {
      blob.text().then((t) => sent.push({ endpoint, body: JSON.parse(t), via: 'beacon', type: blob.type }));
      return true;
    },
    ...navigatorExtra,
  };
  const context = { window: win, document: doc, navigator: nav, fetch: win.fetch, AbortController, URL, URLSearchParams, Blob, Intl, JSON, Date, Math, setTimeout, clearTimeout, Uint8Array, Response };
  win.window = win;
  vm.createContext(context);
  return {
    sent,
    run: () => vm.runInContext(SOURCE, context),
    fire: (type, event = {}) => (listeners[type] || []).forEach((fn) => fn(event)),
    hide: () => {
      doc.visibilityState = 'hidden';
      (listeners.visibilitychange || []).forEach((fn) => fn());
    },
    session,
    local,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('analytics.js', () => {
  test('sends one valid page_view via POST text/plain, with sanitised URLs', () => {
    const b = browser();
    b.run();
    assert.equal(b.sent.length, 1);
    const { endpoint, init, body } = b.sent[0];
    assert.match(endpoint, /\/track$/);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'text/plain');
    assert.equal(init.credentials, 'omit');
    assert.equal(body.event_type, 'page_view');
    assert.equal(body.page_url, 'https://coderopp.github.io/pranavbhadane.github.io/career.html?utm_source=linkedin');
    assert.equal(body.referrer, 'https://www.linkedin.com/feed/');
    assert.equal(body.session_new, true);
    assert.equal(body.returning, false);
    const v = validateEvent(body);
    assert.ok(v.ok, JSON.stringify(v.errors));
  });

  test('double initialisation sends only one page_view', () => {
    const b = browser();
    b.run();
    b.run();
    assert.equal(b.sent.length, 1);
  });

  test('page_exit via sendBeacon is valid and references the page_view', async () => {
    const b = browser();
    b.run();
    b.hide();
    await flush();
    const exit = b.sent.find((s) => s.body.event_type === 'page_exit');
    assert.ok(exit);
    assert.equal(exit.via, 'beacon');
    assert.equal(exit.type, 'text/plain');
    assert.equal(exit.body.view_id, b.sent[0].body.event_id);
    assert.ok(validateEvent(exit.body).ok, JSON.stringify(validateEvent(exit.body).errors));
    b.fire('pagehide');
    await flush();
    assert.equal(b.sent.filter((s) => s.body.event_type === 'page_exit').length, 1, 'no duplicate exit for unchanged time');
  });

  test('session is reused across page loads, then expires after 30 min idle', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    const a = browser({ session, local });
    a.run();
    const b = browser({ session, local, href: 'https://coderopp.github.io/pranavbhadane.github.io/decks.html' });
    b.run();
    assert.equal(a.sent[0].body.session_id, b.sent[0].body.session_id);
    assert.equal(b.sent[0].body.session_new, false);

    const record = JSON.parse(session.getItem('pa_session'));
    record.last -= 31 * 60 * 1000;
    session.setItem('pa_session', JSON.stringify(record));
    const c = browser({ session, local });
    c.run();
    assert.notEqual(c.sent[0].body.session_id, a.sent[0].body.session_id);
    assert.equal(c.sent[0].body.session_new, true);
    assert.equal(c.sent[0].body.returning, true, 'returning browser after the first session');
  });

  test('works without sessionStorage (page-scoped session)', () => {
    const b = browser({ noSessionStorage: true });
    b.run();
    assert.equal(b.sent.length, 1);
    assert.ok(validateEvent(b.sent[0].body).ok);
  });

  test('does not track on other hosts (local dev, forks)', () => {
    const b = browser({ href: 'http://localhost:8000/index.html' });
    b.run();
    assert.equal(b.sent.length, 0);
  });

  test('opt-out: ?analytics=off persists, GPC and DNT are honoured', () => {
    const local = memoryStorage();
    const a = browser({ local, href: 'https://coderopp.github.io/pranavbhadane.github.io/?analytics=off' });
    a.run();
    assert.equal(a.sent.length, 0);
    const b = browser({ local });
    b.run();
    assert.equal(b.sent.length, 0, 'opt-out remembered');
    const c = browser({ navigatorExtra: { globalPrivacyControl: true } });
    c.run();
    assert.equal(c.sent.length, 0);
    const d = browser({ navigatorExtra: { doNotTrack: '1' } });
    d.run();
    assert.equal(d.sent.length, 0);
  });

  test('reports navigator.webdriver for automation detection', () => {
    const b = browser({ navigatorExtra: { webdriver: true } });
    b.run();
    assert.equal(b.sent[0].body.automation, true);
  });

  test('network failure or a throwing fetch never throws into the page', async () => {
    const rejecting = browser({ fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
    assert.doesNotThrow(() => rejecting.run());
    const throwing = browser({ fetchImpl: () => { throw new Error('boom'); } });
    assert.doesNotThrow(() => throwing.run());
    await flush();
  });
});
