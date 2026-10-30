/*
 * Portfolio analytics client (schema v2).
 *
 * Sends one page_view per page load and one page_exit (foreground time) when
 * the page is hidden, to the Cloudflare Worker. Collects no form data, no
 * cookies and no fingerprinting attributes. Tracking failures are swallowed so
 * they can never affect the site.
 *
 * Opt out: visit any page with ?analytics=off (re-enable with ?analytics=on).
 * Browsers sending Global Privacy Control or Do Not Track are not tracked.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://blog-analytics-worker.pranavbhadane279.workers.dev/track';
  var ALLOWED_HOSTS = ['coderopp.github.io'];
  var SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 5000;
  var MAX_EXIT_EVENTS = 5;
  var KEY_SESSION = 'pa_session';
  var KEY_SEEN = 'pa_seen';
  var KEY_OPTOUT = 'pa_optout';

  // Guard against double initialisation (script included twice, re-executed).
  if (window.__portfolioAnalytics) return;
  window.__portfolioAnalytics = { version: 2 };

  try {
    main();
  } catch (e) {
    /* never break the page */
  }

  function storage(kind) {
    try {
      var s = window[kind];
      var probe = '__pa_probe';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (e) {
      return null;
    }
  }

  function randomId() {
    var c = window.crypto;
    if (!c || !c.getRandomValues) return null;
    if (c.randomUUID) return c.randomUUID();
    var bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] + 0x100).toString(16).slice(1);
    return hex;
  }

  function optedOut(local) {
    var param = null;
    try {
      param = new URLSearchParams(window.location.search).get('analytics');
    } catch (e) {}
    if (local && param === 'off') local.setItem(KEY_OPTOUT, '1');
    if (local && param === 'on') local.removeItem(KEY_OPTOUT);
    if (param === 'off') return true;
    if (local && local.getItem(KEY_OPTOUT) === '1') return true;
    if (navigator.globalPrivacyControl === true) return true;
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return true;
    return false;
  }

  // Session = one tab, ending after SESSION_TIMEOUT_MS without activity.
  // Without sessionStorage, the session is scoped to this page load.
  function getSession(session, local, now) {
    var record = null;
    if (session) {
      try {
        record = JSON.parse(session.getItem(KEY_SESSION) || 'null');
      } catch (e) {
        record = null;
      }
    }
    var isNew = !record || typeof record.id !== 'string' || now - record.last > SESSION_TIMEOUT_MS;
    if (isNew) {
      var id = randomId();
      if (!id) return null;
      var returning = local ? local.getItem(KEY_SEEN) === '1' : null;
      record = { id: id, returning: returning };
      if (local) local.setItem(KEY_SEEN, '1');
    }
    record.last = now;
    if (session) session.setItem(KEY_SESSION, JSON.stringify(record));
    return { id: record.id, isNew: isNew, returning: record.returning === undefined ? null : record.returning };
  }

  function touchSession(session, now) {
    if (!session) return;
    try {
      var record = JSON.parse(session.getItem(KEY_SESSION) || 'null');
      if (record) {
        record.last = now;
        session.setItem(KEY_SESSION, JSON.stringify(record));
      }
    } catch (e) {}
  }

  // Keep only campaign parameters; drop anything else (and the hash).
  function cleanPageUrl() {
    var u = new URL(window.location.href);
    var kept = new URLSearchParams();
    u.searchParams.forEach(function (value, key) {
      if (/^utm_[a-z]+$/.test(key) || key === 'ref') kept.append(key, value.slice(0, 100));
    });
    var qs = kept.toString();
    return u.origin + u.pathname + (qs ? '?' + qs : '');
  }

  // Referrer origin + path only: query strings can carry personal data.
  function cleanReferrer() {
    if (!document.referrer) return '';
    try {
      var r = new URL(document.referrer);
      if (r.protocol !== 'http:' && r.protocol !== 'https:') return '';
      return (r.origin + r.pathname).slice(0, 1000);
    } catch (e) {
      return '';
    }
  }

  function language() {
    var l = navigator.language || '';
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(l) ? l : undefined;
  }

  function timezone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return /^[A-Za-z0-9_+\-/]{1,64}$/.test(tz) ? tz : undefined;
    } catch (e) {
      return undefined;
    }
  }

  function send(payload, useBeacon) {
    // text/plain is a CORS-safelisted type: no preflight, and it works with
    // sendBeacon. The Worker parses it as JSON and validates it strictly.
    var body = JSON.stringify(payload);
    if (useBeacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return;
      } catch (e) {}
    }
    if (!window.fetch) return;
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        body: body,
        headers: { 'Content-Type': 'text/plain' },
        keepalive: true,
        credentials: 'omit',
        mode: 'cors',
        signal: controller ? controller.signal : undefined
      })
        .catch(function () {})
        .then(function () { if (timer) clearTimeout(timer); });
    } catch (e) {}
  }

  function main() {
    if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) return;
    var local = storage('localStorage');
    var session = storage('sessionStorage');
    if (optedOut(local)) return;

    var now = Date.now();
    var s = getSession(session, local, now);
    if (!s) return; // no secure random source: do not track

    var common = {
      v: 2,
      page_url: cleanPageUrl(),
      page_path: window.location.pathname,
      session_id: s.id
    };

    var viewId = randomId();
    var view = {
      v: common.v,
      event_id: viewId,
      event_type: 'page_view',
      timestamp: new Date(now).toISOString(),
      page_url: common.page_url,
      page_path: common.page_path,
      referrer: cleanReferrer(),
      session_id: s.id,
      session_new: s.isNew,
      returning: s.returning,
      screen: window.screen ? window.screen.width + 'x' + window.screen.height : undefined,
      timezone: timezone(),
      language: language(),
      automation: navigator.webdriver === true
    };
    send(view, false);

    // Foreground time on this page, reported when the page is hidden.
    var visibleMs = 0;
    var visibleSince = document.visibilityState === 'visible' ? now : null;
    var exitsSent = 0;
    var lastExitVisible = -1;

    function flushExit() {
      var t = Date.now();
      if (visibleSince !== null) {
        visibleMs += t - visibleSince;
        visibleSince = null;
      }
      if (exitsSent >= MAX_EXIT_EVENTS || visibleMs === lastExitVisible) return;
      exitsSent++;
      lastExitVisible = visibleMs;
      touchSession(session, t);
      send({
        v: common.v,
        event_id: randomId(),
        event_type: 'page_exit',
        timestamp: new Date(t).toISOString(),
        page_url: common.page_url,
        page_path: common.page_path,
        session_id: common.session_id,
        view_id: viewId,
        visible_ms: Math.min(Math.round(visibleMs), 86400000)
      }, true);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushExit();
      else if (visibleSince === null) {
        visibleSince = Date.now();
        touchSession(session, visibleSince);
      }
    });
    window.addEventListener('pagehide', flushExit);
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && document.visibilityState === 'visible') visibleSince = Date.now();
    });
  }
})();
