(() => {
  "use strict";

  const canvas = document.getElementById("field");
  const stateEl = document.getElementById("ledger-state");
  const memoryEl = document.getElementById("ledger-memory");
  const lastEl = document.getElementById("ledger-last");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const BONE = "230, 223, 207";
  const RUST = "201, 138, 61";
  const COUNT = 6;
  const SPINE = 16;
  const ATTUNE_AT = 0.8;
  const ATTUNE_MEMORIES = 2;

  let w = 0, h = 0, dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0b0a";
    ctx.fillRect(0, 0, w, h);
    for (const c of colony) placeSpine(c);
    figure = null;
    nextFigureAt = performance.now() / 1000 + 5;
  }

  const pointer = {
    x: 0, y: 0, px: 0, py: 0,
    active: false, held: false,
    speed: 0, lastMove: -10, seen: false
  };

  const trace = [];
  const TRACE_MAX = 160;
  const flashes = [];
  const keptEchoes = [];
  const seen = { kept: false, rehearsed: false };
  const SEEN_KEY = "vestigrin.seen.v1";
  let noticeText = "";
  let noticeUntil = 0;
  let prevKnown = 0;
  let paused = false;
  let resetArmedUntil = 0;
  let lastSave = 0;

  const menuBtn = document.getElementById("menu-btn");
  const panel = document.getElementById("panel");
  const guide = document.getElementById("guide");
  const importFile = document.getElementById("import-file");

  function fromUI(e) {
    try { return !!(e.target && e.target.closest && e.target.closest("#menu-btn,#panel,#guide")); }
    catch (err) { return false; }
  }

  function setLastEvent(t) {
    if (lastEl) lastEl.textContent = t;
  }

  function loadSeen() {
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(SEEN_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        seen.kept = !!o.kept;
        seen.rehearsed = !!o.rehearsed;
      }
    } catch (e) { /* first visit */ }
  }

  function saveSeen() {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch (e) { /* optional */ }
  }

  const SAVE_KEY = "vestigrin.save.v1";
  const SHARE_LIMIT = 1500;

  function round2(n) { return Math.round(n * 100) / 100; }

  function exportState() {
    return {
      app: "vestigrin",
      v: 1,
      savedAt: Date.now(),
      creatures: colony.map((c) => ({
        imprint: Math.max(0, Math.min(1, round2(c.imprint))),
        seed: round2(c.seed),
        phase: round2(c.phase),
        tempo: round2(c.tempo),
        bias: round2(c.bias),
        affinity: round2(c.affinity),
        len: Math.round(c.len * 10) / 10,
        girth: round2(c.girth),
        rust: !!c.rust,
        hand: c.hand >= 0 ? 1 : -1,
        curl: round2(c.curl),
        dwell: round2(c.dwell),
        memory: c.memory.map((m) => ({
          shape: m.shape.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
          strength: Math.max(0, Math.min(1, round2(m.strength))),
          generations: m.generations || 0
        }))
      }))
    };
  }

  function validNum(n, lo, hi) {
    return typeof n === "number" && isFinite(n) && n >= lo && n <= hi;
  }

  function sanitizeState(st) {
    if (!st || typeof st !== "object") return null;
    if (!Array.isArray(st.creatures) || st.creatures.length !== COUNT) return null;
    const creatures = [];
    for (const raw of st.creatures) {
      if (!raw || typeof raw !== "object") return null;
      const mem = [];
      if (Array.isArray(raw.memory)) {
        for (const m of raw.memory.slice(0, 3)) {
          if (!m || !Array.isArray(m.shape)) continue;
          if (m.shape.length < 4 || m.shape.length > 64) continue;
          const shape = [];
          let bad = false;
          for (const p of m.shape) {
            const x = Array.isArray(p) ? p[0] : p && p.x;
            const y = Array.isArray(p) ? p[1] : p && p.y;
            if (!validNum(x, -2000, 2000) || !validNum(y, -2000, 2000)) { bad = true; break; }
            shape.push({ x, y });
          }
          if (bad) continue;
          mem.push({
            shape,
            span: 0,
            taken: 0,
            strength: validNum(m.strength, 0, 1) ? m.strength : 0.5,
            generations: validNum(m.generations, 0, 100000) ? Math.floor(m.generations) : 0
          });
        }
      }
      creatures.push({
        imprint: validNum(raw.imprint, 0, 1) ? raw.imprint : 0,
        seed: validNum(raw.seed, -100000, 100000) ? raw.seed : Math.random() * 1000,
        phase: validNum(raw.phase, -100, 100) ? raw.phase : Math.random() * 6.28,
        tempo: validNum(raw.tempo, 0.2, 2) ? raw.tempo : 0.8,
        bias: validNum(raw.bias, -1, 1) ? raw.bias : 0,
        affinity: validNum(raw.affinity, 0.1, 1.5) ? raw.affinity : 0.6,
        len: validNum(raw.len, 30, 300) ? raw.len : 90,
        girth: validNum(raw.girth, 1, 10) ? raw.girth : 3.5,
        rust: !!raw.rust,
        hand: raw.hand === -1 ? -1 : 1,
        curl: validNum(raw.curl, -1, 1) ? raw.curl : 0,
        dwell: validNum(raw.dwell, 0, 1) ? raw.dwell : 0.5,
        memory: mem
      });
    }
    return { creatures };
  }

  function applyState(st) {
    const clean = sanitizeState(st);
    if (!clean) return false;
    const now = performance.now() / 1000;
    for (let i = 0; i < COUNT; i++) {
      const c = colony[i];
      const s = clean.creatures[i];
      c.imprint = s.imprint;
      c.seed = s.seed; c.phase = s.phase; c.tempo = s.tempo;
      c.bias = s.bias; c.affinity = s.affinity;
      c.len = s.len; c.girth = s.girth; c.rust = s.rust;
      c.hand = s.hand; c.curl = s.curl; c.dwell = s.dwell;
      c.memory = s.memory.map((m) => {
        let span = 0;
        for (const p of m.shape) span = Math.max(span, Math.hypot(p.x, p.y));
        return { shape: m.shape, span, taken: now, strength: m.strength, generations: m.generations };
      });
      c.anchor.x = c.x; c.anchor.y = c.y;
      c.replayIdx = 0; c.replayAt = now; c.rehearsing = false;
    }
    prevKnown = attunedCount();
    return true;
  }

  function saveNow() {
    try {
      if (typeof localStorage === "undefined") return false;
      localStorage.setItem(SAVE_KEY, JSON.stringify(exportState()));
      return true;
    } catch (e) { return false; }
  }

  function loadSaved() {
    try {
      if (typeof localStorage === "undefined") return false;
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      return applyState(JSON.parse(raw));
    } catch (e) { return false; }
  }

  function downsample(shape, max) {
    if (shape.length <= max) return shape;
    const out = [];
    for (let i = 0; i < max; i++) out.push(shape[Math.floor(i * (shape.length - 1) / (max - 1))]);
    return out;
  }

  function b64urlEncode(text) {
    try {
      if (typeof btoa === "undefined") return null;
      return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) { return null; }
  }

  function b64urlDecode(s) {
    try {
      if (typeof atob === "undefined") return null;
      const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
      return decodeURIComponent(escape(atob(b64)));
    } catch (e) { return null; }
  }

  function encodeShare() {
    try {
      const compact = {
        v: 1,
        c: colony.map((c) => [
          Math.round(c.imprint * 100),
          Math.round(c.seed), Math.round(c.phase * 100), Math.round(c.tempo * 100),
          Math.round(c.bias * 100), Math.round(c.affinity * 100), Math.round(c.len),
          c.rust ? 1 : 0, c.hand >= 0 ? 1 : -1,
          Math.round(c.curl * 100), Math.round(c.dwell * 100),
          c.memory.map((m) => [
            downsample(m.shape, 12).map((p) => [Math.round(p.x), Math.round(p.y)]),
            Math.round(m.strength * 100), m.generations || 0
          ])
        ])
      };
      return b64urlEncode(JSON.stringify(compact));
    } catch (e) { return null; }
  }

  function decodeShareParam(s) {
    const text = b64urlDecode(s);
    if (!text) return null;
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || obj.v !== 1 || !Array.isArray(obj.c) || obj.c.length !== COUNT) return null;
    const creatures = [];
    for (const e of obj.c) {
      if (!Array.isArray(e) || e.length < 12) return null;
      const mem = Array.isArray(e[11]) ? e[11] : [];
      creatures.push({
        imprint: Math.max(0, Math.min(1, e[0] / 100)),
        seed: e[1], phase: e[2] / 100, tempo: e[3] / 100, bias: e[4] / 100,
        affinity: e[5] / 100, len: e[6], rust: e[7] === 1, hand: e[8],
        curl: e[9] / 100, dwell: e[10] / 100,
        memory: mem.slice(0, 3).map((m) => ({
          shape: Array.isArray(m[0]) ? m[0] : [],
          strength: typeof m[1] === "number" ? m[1] / 100 : 0.5,
          generations: typeof m[2] === "number" ? m[2] : 0
        }))
      });
    }
    return sanitizeState({ creatures });
  }

  function shareURL() {
    const enc = encodeShare();
    if (!enc) return { ok: false, reason: "encode" };
    if (enc.length > SHARE_LIMIT) return { ok: false, reason: "long" };
    let base = "";
    try { base = String(location.href).split("?")[0].split("#")[0]; }
    catch (e) { return { ok: false, reason: "location" }; }
    return { ok: true, url: base + "?s=" + enc, length: enc.length };
  }

  let figure = null;
  let nextFigureAt = 0;
  let chorusUntil = 0;
  let chorusCooldown = 0;

  function inChorus(now) { return now < chorusUntil; }

  function pushTrace(x, y, t) {
    trace.push({ x, y, t });
    if (trace.length > TRACE_MAX) trace.shift();
  }

  const colony = [];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function makeFigure(now) {
    const cx = rand(w * 0.28, w * 0.72);
    const cy = rand(h * 0.3, h * 0.68);
    const s = Math.max(110, Math.min(220, Math.min(w, h) * 0.24));
    const kind = Math.floor(rand(0, 3));
    const pts = [];
    const n = 42;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      let x = cx, y = cy;
      if (kind === 0) {
        const a = Math.PI * (0.15 + t * 1.1);
        x = cx + Math.cos(a) * s * 0.7;
        y = cy + Math.sin(a) * s * 0.45;
      } else if (kind === 1) {
        const a = t * Math.PI * 2;
        x = cx + Math.cos(a) * s * 0.45;
        y = cy + Math.sin(a) * s * 0.45;
      } else {
        x = cx + (t - 0.5) * s * 1.6;
        y = cy + Math.sin(t * Math.PI * 3) * s * 0.28;
      }
      pts.push({ x, y });
    }
    return { pts, touched: new Array(n).fill(false), born: now, life: 18, resonance: 0 };
  }

  function feedFigure(x, y) {
    if (!figure) return;
    let hit = false;
    for (let i = 0; i < figure.pts.length; i++) {
      if (figure.touched[i]) continue;
      const p = figure.pts[i];
      if (Math.hypot(x - p.x, y - p.y) < 24) {
        figure.touched[i] = true;
        hit = true;
      }
    }
    if (hit) {
      const done = figure.touched.filter(Boolean).length;
      figure.resonance = done / figure.pts.length;
    }
  }

  function teachFigure(now) {
    const ox = figure.pts[0].x, oy = figure.pts[0].y;
    const shape = figure.pts.map((p) => ({ x: p.x - ox, y: p.y - oy }));
    const reach = Math.max(w, h) * 0.45;
    const sorted = colony
      .map((c) => ({ c, d: Math.hypot(figure.pts[0].x - c.x, figure.pts[0].y - c.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const o of sorted) {
      const c = o.c;
      while (c.memory.length >= memoryCap(c)) c.memory.shift();
      c.memory.push({ shape, span: 160, taken: now, strength: 0.95, generations: 0 });
      const closeness = Math.max(0, 1 - o.d / reach);
      c.imprint = Math.min(1, c.imprint + (0.04 + 0.1 * closeness) * (1 - c.imprint * 0.5));
      c.anchor.x = c.x; c.anchor.y = c.y;
      c.replayIdx = 0;
      c.rehearsing = false;
      flashes.push({ x: c.x, y: c.y, t0: now });
    }
    if (flashes.length > 8) flashes.splice(0, flashes.length - 8);
    noticeText = "they learned the figure";
    noticeUntil = now + 3;
    setLastEvent("they learned the figure");
    figure = null;
    nextFigureAt = now + rand(14, 20);
  }

  function makeCreature(i) {
    const cx = w * 0.5 + rand(-60, 60);
    const cy = h * 0.5 + rand(-40, 40);
    const c = {
      x: cx, y: cy,
      vx: rand(-8, 8), vy: rand(-8, 8),
      angle: rand(0, Math.PI * 2),
      spine: [],
      phase: rand(0, Math.PI * 2),
      tempo: rand(0.55, 1.0),
      bias: rand(-1, 1) * 0.25,
      affinity: rand(0.35, 1.0),
      imprint: 0,
      memory: [],
      hand: i % 2 === 0 ? 1 : -1,
      curl: rand(-0.3, 0.3),
      dwell: rand(0, 1),
      anchor: { x: cx, y: cy },
      replayIdx: 0,
      replayAt: 0,
      rehearsing: false,
      len: rand(64, 118),
      girth: rand(2.6, 4.6),
      rust: i === 2,
      seed: rand(0, 1000)
    };
    for (let s = 0; s < SPINE; s++) c.spine.push({ x: cx, y: cy });
    return c;
  }

  function placeSpine(c) {
    for (const s of c.spine) {
      s.x = Math.max(0, Math.min(w, s.x));
      s.y = Math.max(0, Math.min(h, s.y));
    }
  }

  function rememberGesture(c, now) {
    if (trace.length < 20) return false;
    const step = Math.max(1, Math.floor(trace.length / 28));
    const raw = [];
    for (let i = 0; i < trace.length; i += step) raw.push(trace[i]);
    if (raw.length < 8) return false;
    const ox = raw[0].x, oy = raw[0].y;
    const shape = raw.map((p) => ({ x: p.x - ox, y: p.y - oy }));
    let span = 0;
    for (const p of shape) span = Math.max(span, Math.hypot(p.x, p.y));
    if (span < 30) return false;
    while (c.memory.length >= memoryCap(c)) c.memory.shift();
    c.memory.push({
      shape,
      span,
      taken: now,
      strength: Math.min(1, pointer.speed / 36 + (pointer.held ? 0.45 : 0.3)),
      generations: 0
    });
    c.imprint = Math.min(1, c.imprint + 0.05);
    c.anchor.x = c.x; c.anchor.y = c.y;
    c.replayIdx = 0;
    c.rehearsing = false;
    flashes.push({ x: c.x, y: c.y, t0: now });
    if (flashes.length > 8) flashes.shift();
    keptEchoes.push({ pts: raw.map((p) => ({ x: p.x, y: p.y })), t0: now });
    if (keptEchoes.length > 6) keptEchoes.shift();
    return true;
  }

  function memoryCap(c) {
    return c.imprint >= 0.65 ? 3 : c.imprint >= 0.35 ? 2 : 1;
  }

  function mutateMemory(c, mem) {
    const bend = 1.1 + c.dwell * 0.8;
    for (let i = 0; i < mem.shape.length; i++) {
      const p = mem.shape[i];
      p.x += (Math.sin(i * 0.6 + c.seed) * bend + c.curl * 2) * 0.9;
      p.y += (Math.cos(i * 0.5 + c.phase) * bend - c.hand * 0.6) * 0.9;
    }
    let span = 0;
    for (const p of mem.shape) span = Math.max(span, Math.hypot(p.x, p.y));
    if (span > 420 || span < 40) {
      const k = Math.max(40, Math.min(420, span)) / (span || 1);
      for (const p of mem.shape) { p.x *= k; p.y *= k; }
      span = Math.max(40, Math.min(420, span));
    }
    mem.span = span;
    mem.generations = (mem.generations || 0) + 1;
  }

  function isAttuned(c) {
    return c.imprint >= ATTUNE_AT && c.memory.length >= ATTUNE_MEMORIES;
  }

  function attunedCount() {
    let n = 0;
    for (const c of colony) if (isAttuned(c)) n++;
    return n;
  }

  function updateCreature(c, dt, now) {
    const sinceTouch = now - pointer.lastMove;
    const chorus = inChorus(now);
    const idle = sinceTouch > 3 || chorus;

    const precision = 1 - c.imprint * 0.75;
    const pace = 0.7 + c.dwell * 0.4;
    let wander =
      Math.sin(now * 0.5 * c.tempo + c.phase) * 0.9 +
      Math.sin(now * 0.23 * c.tempo + c.seed) * 0.7 +
      c.bias * (1 - c.imprint * 0.5) +
      c.curl * (0.4 + c.imprint * 0.6);
    if (chorus) wander *= 0.35;

    c.angle += wander * dt * (1.1 - c.imprint * 0.6);

    let fx = Math.cos(c.angle) * (12 + c.imprint * 12) * pace;
    let fy = Math.sin(c.angle) * (12 + c.imprint * 12) * pace;

    if (pointer.seen && !idle) {
      const dx = pointer.x - c.x;
      const dy = pointer.y - c.y;
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.max(w, h) * 0.55;
      const pull = Math.max(0, 1 - d / reach);
      const basePull = 6 + c.imprint * 150;
      const gain = basePull * c.affinity * (pointer.held ? 1.9 : 1) + (pointer.held ? 6 : 0);
      fx += (dx / d) * pull * gain;
      fy += (dy / d) * pull * gain;

      const closeness = Math.max(0, 1 - d / (Math.max(w, h) * 0.32));
      const effort = pointer.held ? Math.max(0.45, pointer.speed / 22) : Math.min(1, pointer.speed / 20);
      c.imprint = Math.min(1, c.imprint + dt * 0.09 * closeness * effort);
    }

    if (idle && sinceTouch > 10 && !chorus) {
      let nx = 0, ny = 0, nn = 0;
      for (const o of colony) {
        if (o === c) continue;
        const odx = o.x - c.x, ody = o.y - c.y;
        const od = Math.hypot(odx, ody);
        if (od > 1 && od < Math.max(w, h) * 0.4) { nx += odx / od; ny += ody / od; nn++; }
      }
      if (nn > 0) {
        const pull = 5 + c.affinity * 5;
        fx += (nx / nn) * pull;
        fy += (ny / nn) * pull;
      }
    }

    c.rehearsing = false;
    if ((idle || chorus) && c.memory.length > 0) {
      const mem = c.memory[c.memory.length - 1];
      const restDelay = chorus ? 1.2 : 5;
      if (c.replayIdx >= mem.shape.length) {
        if (now - c.replayAt > restDelay) {
          mutateMemory(c, mem);
          c.replayIdx = 0;
          c.anchor.x = c.x + Math.cos(c.seed) * 18;
          c.anchor.y = c.y + Math.sin(c.seed * 1.3) * 18;
          c.replayAt = now;
        }
      } else {
        if (c.replayIdx === 0 && now - c.replayAt > 0.2) {
          c.anchor.x = c.x + Math.cos(c.seed) * 18;
          c.anchor.y = c.y + Math.sin(c.seed * 1.3) * 18;
        }
        const s = mem.shape[c.replayIdx];
        const err = (1 - c.imprint) * 34;
        const tx = c.anchor.x + s.x + Math.sin(now * 2.1 + c.seed + c.replayIdx * 0.9) * err;
        const ty = c.anchor.y + s.y + Math.cos(now * 1.9 + c.phase + c.replayIdx * 0.7) * err;
        const dx = tx - c.x;
        const dy = ty - c.y;
        let sway = (0.7 + c.imprint * 2.8) * mem.strength;
        if (chorus) sway *= 1.5;
        fx += dx * sway;
        fy += dy * sway;
        c.rehearsing = true;
        if (Math.hypot(dx, dy) < 24) c.replayIdx++;
        if (c.replayIdx >= mem.shape.length) c.replayAt = now;
      }
    }

    c.imprint = Math.max(0, c.imprint - dt * 0.004);

    c.vx += (fx - c.vx) * Math.min(1, dt * 1.7);
    c.vy += (fy - c.vy) * Math.min(1, dt * 1.7);

    const sp = Math.hypot(c.vx, c.vy);
    const max = 40 + c.imprint * 90 + (pointer.held ? 30 : 0);
    if (sp > max) { c.vx *= max / sp; c.vy *= max / sp; }

    c.x += c.vx * dt;
    c.y += c.vy * dt;

    const m = 30;
    if (c.x < -m) c.x = w + m; if (c.x > w + m) c.x = -m;
    if (c.y < -m) c.y = h + m; if (c.y > h + m) c.y = -m;

    let hx = c.x, hy = c.y;
    c.spine[0].x = hx; c.spine[0].y = hy;
    const gap = (c.len * (1 + c.imprint * 0.35)) / SPINE;
    const effTempo = c.tempo * (1 + c.imprint * 0.5);
    for (let s = 1; s < SPINE; s++) {
      const p = c.spine[s];
      const dx = p.x - hx, dy = p.y - hy;
      const d = Math.hypot(dx, dy) || 1;
      const wob = Math.sin(now * 3 * effTempo - s * 0.7 + c.phase) * (1 + s * 0.22) * precision;
      const tx = hx + (dx / d) * gap + -Math.sin(c.angle) * wob * 0.5;
      const ty = hy + (dy / d) * gap + Math.cos(c.angle) * wob * 0.5;
      p.x += (tx - p.x) * Math.min(1, dt * 10);
      p.y += (ty - p.y) * Math.min(1, dt * 10);
      hx = p.x; hy = p.y;
    }
  }

  function drawGhost(c, now) {
    if (!c.rehearsing || c.memory.length === 0) return;
    const mem = c.memory[c.memory.length - 1];
    const gen = Math.min(8, mem.generations || 0);
    const alpha = (inChorus(now) ? 0.22 : 0.11 + gen * 0.008).toFixed(3);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${BONE},${alpha})`;
    ctx.save();
    try {
      if (ctx.setLineDash) ctx.setLineDash([4, 5]);
    } catch (e) { /* solid fallback */ }
    ctx.beginPath();
    for (let i = 0; i < mem.shape.length; i++) {
      const gx = c.anchor.x + mem.shape[i].x;
      const gy = c.anchor.y + mem.shape[i].y;
      if (i === 0) ctx.moveTo(gx, gy);
      else ctx.lineTo(gx, gy);
    }
    ctx.stroke();
    try {
      if (ctx.setLineDash) ctx.setLineDash([]);
    } catch (e) { /* ignore */ }
    const sx = c.anchor.x + mem.shape[0].x;
    const sy = c.anchor.y + mem.shape[0].y;
    let dx = 0, dy = -1;
    if (mem.shape.length > 1) {
      dx = mem.shape[1].x - mem.shape[0].x;
      dy = mem.shape[1].y - mem.shape[0].y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
    }
    ctx.beginPath();
    ctx.moveTo(sx - dy * 3.5, sy + dx * 3.5);
    ctx.lineTo(sx + dy * 3.5, sy - dx * 3.5);
    ctx.stroke();
    ctx.restore();
  }

  function drawCreature(c, now) {
    drawGhost(c, now);
    const col = c.rust ? RUST : BONE;
    const breath = 0.5 + 0.5 * Math.sin(now * 1.4 * c.tempo + c.phase);
    const base = (c.rust ? 0.42 : 0.26) + c.imprint * 0.4 + breath * 0.07 + (c.rehearsing ? 0.1 : 0);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let s = SPINE - 1; s >= 1; s--) {
      const a = c.spine[s - 1], b = c.spine[s];
      const t = s / SPINE;
      const width = c.girth * (1 - t * 0.85) * (1 + breath * 0.15);
      ctx.strokeStyle = `rgba(${col},${(base * (1 - t * 0.75)).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.4, width);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const head = c.spine[0];
    const flick = Math.sin(now * 2.2 * c.tempo + c.phase) * 6;
    const reachLen = 7 + c.imprint * 6;
    const hx2 = head.x + Math.cos(c.angle) * (reachLen + flick * 0.2);
    const hy2 = head.y + Math.sin(c.angle) * (reachLen + flick * 0.2);
    ctx.strokeStyle = `rgba(${col},${(base + 0.25).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    ctx.lineTo(hx2, hy2);
    ctx.stroke();

    ctx.fillStyle = `rgba(${col},${Math.min(0.9, base + 0.35).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(head.x, head.y, c.rust ? 1.8 : 1.2 + c.imprint * 1.0, 0, Math.PI * 2);
    ctx.fill();

    if (c.imprint > 0.02) {
      ctx.strokeStyle = `rgba(${col},0.35)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 4.2, -Math.PI / 2, -Math.PI / 2 + c.imprint * Math.PI * 2);
      ctx.stroke();
    }

    if (c.imprint >= ATTUNE_AT && c.memory.length >= ATTUNE_MEMORIES) {
      ctx.strokeStyle = `rgba(${col},0.5)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 5.5 + Math.sin(now * 2 + c.phase) * 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawFigure(now) {
    if (!figure) return;
    const age = now - figure.born;
    const fadeIn = Math.min(1, age / 1.5);
    const fadeOut = Math.min(1, (figure.life - age) / 3);
    const fade = Math.max(0, Math.min(1, Math.min(fadeIn, fadeOut)));
    if (fade <= 0) return;
    const base = (0.1 + figure.resonance * 0.25) * fade;
    ctx.lineWidth = 1;
    ctx.save();
    try {
      if (ctx.setLineDash) ctx.setLineDash([2, 7]);
    } catch (e) { /* keep solid line if unsupported */ }
    ctx.strokeStyle = `rgba(${BONE},${base.toFixed(3)})`;
    ctx.beginPath();
    for (let i = 0; i < figure.pts.length; i++) {
      const p = figure.pts[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    try {
      if (ctx.setLineDash) ctx.setLineDash([]);
    } catch (e) { /* ignore */ }
    ctx.strokeStyle = `rgba(${BONE},${(base + 0.25 * fade).toFixed(3)})`;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < figure.pts.length; i++) {
      if (!figure.touched[i]) continue;
      const p = figure.pts[i];
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    if (started) ctx.stroke();
    ctx.restore();
  }

  function drawFlashes(now) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      const age = now - f.t0;
      if (age > 1.4) { flashes.splice(i, 1); continue; }
      const r = 4 + age * 26;
      const alpha = 0.4 * (1 - age / 1.4);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${BONE},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawKeptEchoes(now) {
    for (let i = keptEchoes.length - 1; i >= 0; i--) {
      const e = keptEchoes[i];
      const age = now - e.t0;
      if (age > 1.6) { keptEchoes.splice(i, 1); continue; }
      const alpha = 0.34 * (1 - age / 1.6);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${BONE},${alpha.toFixed(3)})`;
      ctx.beginPath();
      for (let k = 0; k < e.pts.length; k++) {
        if (k === 0) ctx.moveTo(e.pts[k].x, e.pts[k].y);
        else ctx.lineTo(e.pts[k].x, e.pts[k].y);
      }
      ctx.stroke();
    }
  }

  function drawTraceEcho(now) {
    if (trace.length < 2) return;
    ctx.lineWidth = 1;
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i - 1], b = trace[i];
      const age = now - b.t;
      if (age > 1.6) continue;
      const alpha = 0.22 * (1 - age / 1.6);
      ctx.strokeStyle = `rgba(${BONE},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  let lastLedger = 0;
  let shownLabel = "drifting";
  let candidateLabel = "drifting";
  let candidateSince = 0;

  function setLabel(now, label, force) {
    if (force) {
      shownLabel = label;
      candidateLabel = label;
      candidateSince = now;
      stateEl.textContent = label;
      return;
    }
    if (label === shownLabel) {
      candidateLabel = label;
      return;
    }
    if (label !== candidateLabel) {
      candidateLabel = label;
      candidateSince = now;
      return;
    }
    if (now - candidateSince > 0.9) {
      shownLabel = label;
      stateEl.textContent = label;
    }
  }

  function updateLedger(now) {
    if (now - lastLedger < 0.4) return;
    lastLedger = now;
    if (now < noticeUntil) {
      setLabel(now, noticeText, true);
    } else if (inChorus(now)) {
      setLabel(now, "they move as one", true);
    } else {
      const sinceTouch = now - pointer.lastMove;
      const rehearsing = colony.some((c) => c.rehearsing);
      let label = "drifting";
      if (figure && figure.resonance > 0.05) label = "teaching the figure";
      else if (figure) label = "a figure waits";
      else if (pointer.held) label = "gathering";
      else if (sinceTouch < 1.2) label = "watching";
      else if (rehearsing) {
        if (!seen.rehearsed) {
          seen.rehearsed = true;
          saveSeen();
          label = "replaying what it kept";
        } else {
          label = "rehearsing your line";
        }
      }
      else if (sinceTouch < 3) label = "settling";
      else label = colony.some((c) => c.memory.length > 0) ? "remembering" : (colony.reduce((s, c) => s + c.imprint, 0) / colony.length < 0.08 ? "unaware" : "drifting");
      setLabel(now, label, false);
    }
    const avg = colony.reduce((s, c) => s + c.imprint, 0) / colony.length;
    const kept = colony.reduce((s, c) => s + c.memory.length, 0);
    const depth = avg < 0.15 ? "thin" : avg < 0.45 ? "gathering" : "deep";
    const known = attunedCount();
    memoryEl.textContent = kept === 0 && known === 0 ? depth : `${depth} · ${known}/${COUNT} know you`;
  }

  let last = performance.now() / 1000;
  let gestureCooldown = 0;

  function frame() {
    const now = performance.now() / 1000;
    if (paused) {
      last = now;
      setLabel(now, "paused", true);
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.05, now - last);
    last = now;

    ctx.fillStyle = "rgba(11, 11, 10, 0.075)";
    ctx.fillRect(0, 0, w, h);

    pointer.speed *= 0.92;

    if (!figure && now >= nextFigureAt) figure = makeFigure(now);
    if (figure) {
      if (now - figure.born > figure.life) {
        figure = null;
        nextFigureAt = now + rand(10, 16);
      } else if (figure.resonance >= 0.9) {
        teachFigure(now);
      }
    }

    const known = attunedCount();
    if (known > prevKnown) {
      noticeText = `a form knows you · ${known}/${COUNT}`;
      noticeUntil = now + 3;
      setLastEvent(`a form knows you · ${known}/${COUNT}`);
    }
    prevKnown = known;
    if (known >= COUNT && now >= chorusCooldown && !inChorus(now)) {
      chorusUntil = now + 9;
      chorusCooldown = now + 30;
      noticeText = "they move as one";
      noticeUntil = now + 4;
      setLastEvent("they move as one");
    }

    for (const c of colony) {
      updateCreature(c, dt, now);
      drawCreature(c, now);
    }
    drawFigure(now);
    drawFlashes(now);
    drawKeptEchoes(now);
    drawTraceEcho(now);

    if (pointer.seen && now - pointer.lastMove < 2 && now > gestureCooldown) {
      const sorted = colony
        .map((c) => ({ c, d: Math.hypot(pointer.x - c.x, pointer.y - c.y) }))
        .filter((o) => o.d < Math.max(w, h) * 0.35)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      if (sorted.length > 0 && (pointer.speed > 2.5 || pointer.held)) {
        let keptAny = false;
        for (const o of sorted) {
          if (rememberGesture(o.c, now)) keptAny = true;
        }
        if (keptAny) {
          if (!seen.kept) {
            seen.kept = true;
            saveSeen();
            noticeText = "kept — now stay still";
          } else {
            noticeText = sorted.length > 1 ? "kept your trace" : "kept a trace";
          }
          noticeUntil = now + 3;
          setLastEvent(noticeText);
          gestureCooldown = now + 2.2;
        } else {
          gestureCooldown = now + 0.5;
        }
      }
    }

    updateLedger(now);
    if (now - lastSave > 5) { lastSave = now; saveNow(); }
    requestAnimationFrame(frame);
  }

  function onMove(x, y) {
    const now = performance.now() / 1000;
    const dx = x - pointer.x, dy = y - pointer.y;
    const inst = Math.hypot(dx, dy);
    pointer.speed = pointer.speed * 0.6 + inst * 0.4;
    pointer.px = pointer.x; pointer.py = pointer.y;
    pointer.x = x; pointer.y = y;
    pointer.lastMove = now;
    if (!pointer.seen) {
      pointer.seen = true;
      pointer.lastMove = now;
    }
    pushTrace(x, y, now);
    if (inst > Math.max(w, h) * 0.2) trace.length = 0;
    feedFigure(x, y);
  }

  window.addEventListener("pointermove", (e) => {
    if (fromUI(e)) return;
    onMove(e.clientX, e.clientY);
  }, { passive: true });
  window.addEventListener("pointerdown", (e) => {
    if (fromUI(e)) return;
    pointer.held = true;
    onMove(e.clientX, e.clientY);
  }, { passive: true });
  window.addEventListener("pointerup", () => { pointer.held = false; }, { passive: true });
  window.addEventListener("pointercancel", () => { pointer.held = false; }, { passive: true });
  window.addEventListener("pointerleave", () => { pointer.held = false; }, { passive: true });
  window.addEventListener("blur", () => { pointer.held = false; });
  window.addEventListener("resize", resize);

  document.addEventListener("touchmove", (e) => {
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  function buildColony() {
    colony.length = 0;
    for (let i = 0; i < COUNT; i++) colony.push(makeCreature(i));
  }

  function pauseToggle() {
    paused = !paused;
    const now = performance.now() / 1000;
    if (paused) {
      saveNow();
      setLabel(now, "paused", true);
    } else {
      last = now;
    }
    syncPanel();
  }

  function doReset() {
    const now = performance.now() / 1000;
    buildColony();
    trace.length = 0;
    flashes.length = 0;
    keptEchoes.length = 0;
    figure = null;
    nextFigureAt = now + 6;
    chorusUntil = 0;
    chorusCooldown = 0;
    resetArmedUntil = 0;
    prevKnown = 0;
    noticeText = "forgotten";
    noticeUntil = now + 3;
    setLastEvent("—");
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(SAVE_KEY);
    } catch (e) { /* keep going without storage */ }
    syncPanel();
  }

  function resetAction() {
    const now = performance.now() / 1000;
    if (now < resetArmedUntil) { doReset(); return; }
    resetArmedUntil = now + 4;
    noticeText = "reset? once more to forget";
    noticeUntil = now + 3;
    syncPanel();
  }

  function copyText(t, okMsg) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(
          () => setLastEvent(okMsg),
          () => setLastEvent("copy failed")
        );
        return true;
      }
    } catch (e) { /* no clipboard */ }
    return false;
  }

  function downloadJSON(name, text) {
    try {
      if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return false;
      if (typeof document === "undefined" || !document.createElement) return false;
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      if (document.body && document.body.appendChild) {
        document.body.appendChild(a);
        if (typeof a.click === "function") a.click();
        document.body.removeChild(a);
      }
      return true;
    } catch (e) { return false; }
  }

  function exportAction() {
    const text = JSON.stringify(exportState());
    const now = performance.now() / 1000;
    const saved = downloadJSON("vestigrin-memory.json", text);
    const copied = copyText(text, "exported · copied");
    if (saved || copied) {
      noticeText = "exported";
      noticeUntil = now + 3;
      if (!copied) setLastEvent("exported");
    } else {
      noticeText = "export failed";
      noticeUntil = now + 3;
      setLastEvent("export failed");
    }
  }

  function importStateObject(obj) {
    const now = performance.now() / 1000;
    if (applyState(obj)) {
      saveNow();
      noticeText = "imported";
      noticeUntil = now + 3;
      setLastEvent("imported");
      return true;
    }
    noticeText = "import failed";
    noticeUntil = now + 3;
    setLastEvent("import failed");
    return false;
  }

  function importFileAction(file) {
    if (!file || typeof file.text !== "function") {
      setLastEvent("import failed");
      return;
    }
    file.text().then(
      (text) => {
        let obj = null;
        try { obj = JSON.parse(text); } catch (e) { obj = null; }
        importStateObject(obj);
      },
      () => {
        const now = performance.now() / 1000;
        noticeText = "import failed";
        noticeUntil = now + 3;
        setLastEvent("import failed");
      }
    );
  }

  function shareAction() {
    const now = performance.now() / 1000;
    const res = shareURL();
    if (res.ok) {
      if (copyText(res.url, "link copied")) {
        noticeText = "link copied";
        noticeUntil = now + 3;
      } else {
        noticeText = "copy failed · use export";
        noticeUntil = now + 3;
        setLastEvent("copy failed");
      }
      return;
    }
    if (res.reason === "long") {
      const full = JSON.stringify(exportState());
      if (copyText(full, "link too long · copied memory")) {
        noticeText = "link too long · copied memory";
        noticeUntil = now + 3;
      } else {
        noticeText = "link too long · use export";
        noticeUntil = now + 3;
        setLastEvent("share failed");
      }
      return;
    }
    noticeText = "share failed";
    noticeUntil = now + 3;
    setLastEvent("share failed");
  }

  function togglePanel(force) {
    if (!panel || !menuBtn) return;
    const show = typeof force === "boolean" ? force : panel.hidden;
    panel.hidden = !show;
    menuBtn.setAttribute("aria-expanded", show ? "true" : "false");
  }

  function toggleGuide(force) {
    if (!guide) return;
    guide.hidden = typeof force === "boolean" ? !force : !guide.hidden;
  }

  function syncPanel() {
    if (!panel) return;
    const btn = panel.querySelector('[data-act="pause"]');
    if (btn) btn.textContent = paused ? "resume" : "pause";
    const resetBtn = panel.querySelector('[data-act="reset"]');
    if (resetBtn) {
      const now = performance.now() / 1000;
      resetBtn.textContent = now < resetArmedUntil ? "sure?" : "reset";
    }
  }

  function bootState() {
    try {
      const q = (typeof location !== "undefined" && location.search) || "";
      const m = q.match(/[?&]s=([^&]+)/);
      if (m) {
        const st = decodeShareParam(m[1]);
        if (st && applyState(st)) {
          setLastEvent("a shared memory");
          return;
        }
      }
    } catch (e) { /* fall through to storage */ }
    try {
      if (loadSaved()) setLastEvent("continued");
    } catch (e) { /* fresh start */ }
  }

  if (menuBtn && panel) {
    menuBtn.addEventListener("click", () => {
      togglePanel();
      if (menuBtn.blur) menuBtn.blur();
    });
    panel.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      if (act === "pause") pauseToggle();
      else if (act === "reset") resetAction();
      else if (act === "guide") toggleGuide();
      else if (act === "export") exportAction();
      else if (act === "import" && importFile) importFile.click();
      else if (act === "share") shareAction();
      if (btn.blur) btn.blur();
      syncPanel();
    });
  }

  if (importFile) {
    importFile.addEventListener("change", () => {
      if (importFile.files && importFile.files[0]) importFileAction(importFile.files[0]);
      importFile.value = "";
    });
  }

  window.addEventListener("keydown", (e) => {
    try {
      if (e.target && e.target.closest && e.target.closest("input,textarea")) return;
    } catch (err) { /* keep handling */ }
    if (e.code === "Space") {
      e.preventDefault();
      pauseToggle();
    } else if (e.key === "h" || e.key === "H") toggleGuide();
    else if (e.key === "e" || e.key === "E") exportAction();
    else if (e.key === "s" || e.key === "S") shareAction();
    else if (e.key === "r" || e.key === "R") resetAction();
    else if (e.key === "Escape") { togglePanel(false); toggleGuide(false); }
  });

  try {
    document.addEventListener("visibilitychange", () => {
      if (typeof document !== "undefined" && document.hidden) saveNow();
    });
  } catch (e) { /* optional */ }
  window.addEventListener("pagehide", () => saveNow());

  resize();
  pointer.x = w / 2; pointer.y = h / 2;
  buildColony();
  loadSeen();
  bootState();
  nextFigureAt = performance.now() / 1000 + 6;
  ctx.fillStyle = "#0b0b0a";
  ctx.fillRect(0, 0, w, h);
  requestAnimationFrame(frame);

  try {
    if (typeof window !== "undefined") {
      window.__vestigrin = {
        colony, pointer, seen,
        get figure() { return figure; },
        get paused() { return paused; },
        get echoes() { return keptEchoes; },
        now() { return performance.now() / 1000; },
        pauseToggle, doReset, saveNow, loadSaved,
        exportState, applyState, encodeShare, decodeShareParam, shareURL,
        importStateObject, mutateMemory, memoryCap, attunedCount, isAttuned
      };
    }
  } catch (e) { /* testing api optional */ }
})();
