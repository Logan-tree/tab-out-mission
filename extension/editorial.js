/* ============================================================
   editorial.js
   Bridge layer for the Variant A · Nuri redesign.
   Loaded AFTER app.js — fills in the new editorial chrome
   (top meta strip, hello-meta, favicon color swatches) without
   modifying app.js.
   ============================================================ */

(function () {
  'use strict';

  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const pad = (n) => String(n).padStart(2, '0');

  /* ============ ISO week + day-of-year ============ */
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }
  function dayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / 86400000);
  }
  function isLeap(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  /* ============ Top meta strip ============ */
  // Map JS day-of-week (0=Sun..6=Sat) into Mon-first index (0=Mon..6=Sun).
  function isoDayIndex(date) {
    return (date.getDay() + 6) % 7;
  }
  const WEEK_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  function tickTopbar() {
    const now = new Date();
    const hh = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    const set = (id, t) => {
      const el = document.getElementById(id);
      if (el) el.textContent = t;
    };
    set('topbarWeek', `W${pad(isoWeek(now))}`);
    // Hero time (replaces greeting): HH:MM big, :SS small raised.
    set('heroTimeMain', `${hh}:${mm}`);
    set('heroTimeSec', `:${ss}`);
    // Legacy hidden compat (still referenced by some existing render paths)
    set('topbarDate', `${DAYS[now.getDay()]} · ${pad(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`);
    set('topbarDay', `D${pad(dayOfYear(now))}`);
  }

  /* ============ Focus / Clarity mode toggle ============
     body.clarity-mode disables the always-on focus dim/blur so every
     section reads at full opacity. State persists across reloads via
     chrome.storage.local with localStorage fallback. */
  const MODE_KEY = 'tom_clarity_mode';

  function applyClarityMode(on) {
    document.body.classList.toggle('clarity-mode', !!on);
    const btn = document.getElementById('topbarModeToggle');
    const label = document.getElementById('modeToggleLabel');
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'false' : 'true');
      btn.title = on ? 'Focus blur off — click to re-enable' : 'Focus blur on — click for clarity mode';
    }
    if (label) label.textContent = on ? 'CLARITY' : 'FOCUS';
  }

  function readClarityMode(cb) {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([MODE_KEY], (res) => cb(!!(res && res[MODE_KEY])));
        return;
      }
    } catch (_) { /* fall through */ }
    cb(localStorage.getItem(MODE_KEY) === '1');
  }

  function writeClarityMode(on) {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [MODE_KEY]: !!on });
        return;
      }
    } catch (_) { /* fall through */ }
    if (on) localStorage.setItem(MODE_KEY, '1');
    else localStorage.removeItem(MODE_KEY);
  }

  function wireModeToggle() {
    const btn = document.getElementById('topbarModeToggle');
    if (!btn) return;
    readClarityMode((on) => applyClarityMode(on));
    btn.addEventListener('click', () => {
      const next = !document.body.classList.contains('clarity-mode');
      applyClarityMode(next);
      writeClarityMode(next);
      btn.blur();
    });
  }

  /* Render the M T W T F S S markers (only changes once per day). */
  let _weekRenderedKey = '';
  function renderWeekMarkers() {
    const host = document.getElementById('weekMarkers');
    if (!host) return;
    const now = new Date();
    const idx = isoDayIndex(now);
    const key = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (key === _weekRenderedKey) return;
    _weekRenderedKey = key;

    host.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const cell = document.createElement('div');
      cell.className =
        'week-marker ' +
        (i < idx ? 'is-past' : i === idx ? 'is-current' : 'is-future');
      cell.innerHTML =
        `<span class="week-marker-letter">${WEEK_LETTERS[i]}</span>` +
        `<span class="week-marker-dot"></span>`;
      host.appendChild(cell);
    }
  }

  /* Render the year timeline (365/366 marks) — once per day.
     - Each day is a flex:1 mark; past=ink, current=purple+taller,
       future=faint, month-start=taller for visual anchor.
     - Pointer (D### ▼) sits above the bar at today's percentage.
     - Month labels are positioned by actual day-of-year (Feb=32,
       Mar=60, …), so the gap before Dec doesn't look too wide. */
  let _yearRenderedKey = '';
  function renderYearBar() {
    const track = document.getElementById('yearBarTrack');
    const pointer = document.getElementById('yearBarPointer');
    const label = document.getElementById('yearBarPointerLabel');
    const monthsHost = document.getElementById('yearMonths');
    if (!track || !pointer || !label || !monthsHost) return;

    const now = new Date();
    const year = now.getFullYear();
    const yearLen = isLeap(year) ? 366 : 365;
    const today = dayOfYear(now); // 1..365/366
    const key = `${year}-${today}`;
    if (key === _yearRenderedKey) return;
    _yearRenderedKey = key;

    // Pre-compute first-of-month days for "is-month-start" + label x.
    const monthStartDay = [];
    const monthStartSet = new Set();
    for (let m = 0; m < 12; m++) {
      const d = dayOfYear(new Date(year, m, 1));
      monthStartDay.push(d);
      monthStartSet.add(d);
    }

    // Render the 365/366 marks.
    track.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let d = 1; d <= yearLen; d++) {
      const m = document.createElement('span');
      const classes = ['year-bar-mark'];
      classes.push(d < today ? 'is-past' : d === today ? 'is-current' : 'is-future');
      if (monthStartSet.has(d)) classes.push('is-month-start');
      m.className = classes.join(' ');
      frag.appendChild(m);
    }
    track.appendChild(frag);

    // Pointer at today's centered percentage, accounting for the
    // 32px horizontal padding on .year-bar.
    const todayPct = ((today - 0.5) / yearLen) * 100;
    pointer.style.left = `calc(32px + (100% - 64px) * ${todayPct} / 100)`;
    label.textContent = `D${pad(today)}`;

    // Month labels — centered in each month's actual day range.
    // .year-months is a block-level child of .year-bar (which has the 32px
    // gutter padding), so its OWN content area already matches the track's
    // inner width. Span positions are simple percentages — no calc / -64px.
    monthsHost.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const startD = monthStartDay[i];
      const endD = i < 11 ? monthStartDay[i + 1] - 1 : yearLen;
      const midD = (startD + endD) / 2;
      const midPct = ((midD - 0.5) / yearLen) * 100;
      const span = document.createElement('span');
      span.textContent = MONTHS[i];
      span.style.left = `${midPct}%`;
      monthsHost.appendChild(span);
    }
  }

  /* ============ Mission-tab brand color swatches ============
     Open Tabs keep their real favicon images (Chrome's tab-bar favicons).
     Mission tabs swap each <img.chip-favicon> for a flat colored swatch —
     small multicolor icons don't read on the purple slab. */

  const BRAND = {
    'gmail.com': '#D44638',
    'mail.google.com': '#D44638',
    'x.com': '#1DA1F2',
    'twitter.com': '#1DA1F2',
    'linkedin.com': '#0A66C2',
    'youtube.com': '#FF0000',
    'github.com': '#0E0E10',
    'anthropic.com': '#D97757',
    'claude.ai': '#D97757',
    'support.claude.com': '#D97757',
    'console.anthropic.com': '#D97757',
    'platform.claude.com': '#D97757',
    'docs.anthropic.com': '#D97757',
    'openai.com': '#10A37F',
    'platform.openai.com': '#10A37F',
    'chatgpt.com': '#10A37F',
    'figma.com': '#A259FF',
    'notion.so': '#000000',
    'notion.com': '#000000',
    'stripe.com': '#635BFF',
    'vercel.com': '#000000',
    'linear.app': '#5E6AD2',
    'discord.com': '#5865F2',
    'slack.com': '#4A154B',
    'reddit.com': '#FF4500',
    'medium.com': '#000000',
    'substack.com': '#FF6719',
    'spotify.com': '#1DB954',
    'apple.com': '#000000',
    'google.com': '#4285F4',
    'docs.google.com': '#4285F4',
    'drive.google.com': '#0F9D58',
    'meet.google.com': '#00897B',
    'calendar.google.com': '#4285F4',
    'maps.google.com': '#34A853',
    'amazon.com': '#FF9900',
    'ebay.com': '#E53238',
    'instagram.com': '#E4405F',
    'pinterest.com': '#E60023',
    'tiktok.com': '#000000',
    'twitch.tv': '#9146FF',
    'mozilla.org': '#FF7139',
    'wikipedia.org': '#000000',
    'arxiv.org': '#B31B1B',
    'producthunt.com': '#DA552F',
    'meetup.com': '#ED1C40',
    'eventbrite.com': '#F05537',
    'eventbrite.co.uk': '#F05537',
    'airbnb.com': '#FF5A5F',
    'dropbox.com': '#0061FF',
    'zoom.us': '#2D8CFF',
  };

  function extractDomain(input) {
    if (!input) return null;
    let m = /[?&]domain=([^&]+)/.exec(input);
    if (m) return decodeURIComponent(m[1]);
    try { return new URL(input).hostname; } catch { /* noop */ }
    return null;
  }

  function colorForDomain(domain) {
    if (!domain) return 'rgba(239, 235, 226, 0.55)';
    let d = String(domain).toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
    if (BRAND[d]) return BRAND[d];
    const parts = d.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (BRAND[candidate]) return BRAND[candidate];
    }
    return null; // unknown — let extractFaviconColor fill it in
  }

  /* Score buckets by count × chroma² so vivid brand pixels beat the
     larger volume of near-neutral anti-aliased background pixels. */
  function dominantColorFromPixels(pixels) {
    const buckets = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
      if (a < 200) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 30) continue;
      if (min > 230) continue;
      const chroma = max - min;
      if (chroma < 24) continue;
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
      buckets.set(key, bucket);
      bucket.chromaSum = (bucket.chromaSum || 0) + chroma;
    }
    if (!buckets.size) return null;
    let top = null, topScore = -1;
    for (const b of buckets.values()) {
      const avgChroma = b.chromaSum / b.count;
      const score = b.count * avgChroma * avgChroma;
      if (score > topScore) { topScore = score; top = b; }
    }
    return `rgb(${Math.round(top.r / top.count)}, ${Math.round(top.g / top.count)}, ${Math.round(top.b / top.count)})`;
  }

  const _faviconColorCache = new Map();

  function extractFaviconColor(domain) {
    if (!domain) return Promise.resolve(null);
    if (_faviconColorCache.has(domain)) {
      return Promise.resolve(_faviconColorCache.get(domain));
    }
    const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 32;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32).data;
          const color = dominantColorFromPixels(data);
          _faviconColorCache.set(domain, color);
          resolve(color);
        } catch (_) {
          _faviconColorCache.set(domain, null);
          resolve(null);
        }
      };
      img.onerror = () => { _faviconColorCache.set(domain, null); resolve(null); };
      img.src = url;
    });
  }

  function paintMissionFavicons() {
    // Disabled — mission tabs now keep their real favicon images, same as
    // the rest of the dashboard. The swatch logic below is preserved in
    // case we want to bring it back.
    return;
    const imgs = document.querySelectorAll('.mission-active .mission-tab img.chip-favicon');
    imgs.forEach((img) => {
      const url = img.getAttribute('src') || '';
      const domain = extractDomain(url);
      const norm = domain && domain.toLowerCase().replace(/^www\./, '');
      const swatch = document.createElement('div');
      swatch.className = 'mission-favicon-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const curated = colorForDomain(norm);
      if (curated) swatch.style.background = curated;
      if (norm) swatch.dataset.domain = norm;
      img.replaceWith(swatch);

      // Async-fill unknowns from the actual favicon image.
      if (norm && !BRAND[norm]) {
        extractFaviconColor(norm).then((real) => {
          if (!real) return;
          document
            .querySelectorAll(`.mission-active .mission-favicon-swatch[data-domain="${CSS.escape(norm)}"]`)
            .forEach((el) => { el.style.background = real; });
        });
      }
    });
  }

  /* ============ Hello-meta (tabs / dupes / sunset) ============ */
  function updateHelloMeta() {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return;
    chrome.tabs.query({}, (tabs) => {
      const tabsEl = document.getElementById('statTabs');
      if (tabsEl) tabsEl.textContent = `${tabs.length} tabs open`;

      // Count duplicates by URL
      const seen = new Map();
      let dupes = 0;
      for (const t of tabs) {
        if (!t.url) continue;
        const n = (seen.get(t.url) || 0) + 1;
        seen.set(t.url, n);
        if (n === 2) dupes++; // count each dup-set once
      }
      const dupeEl = document.getElementById('statDupes');
      if (dupeEl) dupeEl.textContent = `${dupes} duplicate${dupes === 1 ? '' : 's'} flagged`;
    });
  }

  /* ============ Issue number — D… of year ============ */
  function setIssueNumber() {
    const now = new Date();
    const issue = `№${String(dayOfYear(now)).padStart(3, '0')}`;
    const el = document.getElementById('topbarTitle');
    if (el) el.textContent = `TAB OUT MISSION · ${issue}`;
  }

  /* ============ Boot ============ */
  function boot() {
    tickTopbar();
    setIssueNumber();
    renderWeekMarkers();
    renderYearBar();
    updateHelloMeta();
    wireModeToggle();
    paintMissionFavicons();

    setInterval(() => {
      tickTopbar();
      renderWeekMarkers();
      renderYearBar();
    }, 1000);
    setInterval(updateHelloMeta, 5000);

    // Re-paint when the mission slab re-renders (drag, edit, complete).
    const missionRoot = document.getElementById('missionSection');
    if (missionRoot) {
      const obs = new MutationObserver(() => paintMissionFavicons());
      obs.observe(missionRoot, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
