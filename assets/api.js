/* Pearler Pool — API client + shared helpers
 * Live pool API: https://p2.pearlerpool.com  (endpoints: /health /pool/info /stats /miners /miners/<addr> /pool/blocks)
 *
 * The API is a different origin from the site, so by default we call it through a
 * same-origin Vercel proxy (see vercel.json rewrite: /pool-api/* -> https://p2.pearlerpool.com/*)
 * to avoid CORS. Override if you ever serve the site from the pool host itself:
 *   window.PEARLER_API_BASE = "";                      // same-origin (served from pool public/)
 *   window.PEARLER_API_BASE = "https://p2.pearlerpool.com"; // direct (needs CORS on the API)
 *
 * NOTE: the live API does NOT wrap responses in { data: ... } (the spec did) — we handle both.
 */
(function (global) {
  var BASE = (global.PEARLER_API_BASE != null ? global.PEARLER_API_BASE : "/pool-api").replace(/\/$/, "");
  // grains -> PRL. ~256,236,503,863 grains ≈ 2,562 PRL block reward => ~1e8. CONFIRM with backend.
  var GRAINS_PER_PRL = global.PEARLER_GRAINS_PER_PRL || 1e8;

  var PP = { usingMock: false, base: BASE, GRAINS_PER_PRL: GRAINS_PER_PRL };

  /* ---------- fetch (unwraps {data} if present) with sample fallback ---------- */
  async function api(path) {
    try {
      var r = await fetch(BASE + path, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(r.status);
      var j = await r.json();
      return j && typeof j === "object" && j.data !== undefined ? j.data : j;
    } catch (e) {
      PP.usingMock = true;
      return mock(path);
    }
  }

  /* ---------- like api() but NEVER falls back to mock (returns null on 404/error) ----------
     Use for per-address lookups so a 404 ("not a miner on this pool") never shows fake data. */
  async function apiRaw(path) {
    try {
      var r = await fetch(BASE + path, { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      var j = await r.json();
      return j && typeof j === "object" && j.data !== undefined ? j.data : j;
    } catch (e) { return null; }
  }

  /* ---------- on-chain network state via PearlTrack (same-origin proxy /net-api) ---------- */
  async function netApi(path) {
    try {
      var r = await fetch("/net-api" + path, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) { return null; }
  }

  /* ---------- field accessors (tolerant of spec vs live naming) ---------- */
  function job(stats) { return (stats && (stats.job || stats.current_job)) || {}; }
  function subs(stats) { return (stats && (stats.submissions || stats.blocks)) || {}; }
  function blocksFound(stats) { var s = subs(stats); return s.accepted != null ? s.accepted : 0; }
  function activeMiners(stats) { return (stats && stats.stratum && stats.stratum.sessions) || 0; }
  function feePct(info) {
    var e = info && info.economics; if (!e) return null;
    if (e.fee_bps != null) return e.fee_bps / 100;
    if (e.pool_fee != null) { var n = parseFloat(e.pool_fee); return isNaN(n) ? null : n; }
    return null;
  }
  function rewardPRL(stats) { var j = job(stats); return j.reward_grains != null ? Number(j.reward_grains) / GRAINS_PER_PRL : 0; }
  function poolHashrate(stats) { return stats && stats.hashrate != null ? String(stats.hashrate) : null; } // live pool hashrate, pre-formatted e.g. "124.64 GH/s"
  function minerHashrate(miners, addr) { var l = topMiners(miners); for (var i = 0; i < l.length; i++) { if (l[i].payout_addr === addr && l[i].hashrate != null) return String(l[i].hashrate); } return null; }
  function pplnsWindow(info) { var e = info && info.economics; return e && e.pplns_window_shares != null ? e.pplns_window_shares : null; }

  /* ---------- sample data (matches the LIVE shapes) ---------- */
  function mock(path) {
    if (path === "/health") return { ok: true, ts: Date.now() };
    if (path === "/pool/info") return {
      name: "p2", domain: "pearlerpool.com", operator_email: "ops@pearlerpool.com", version: "0.1.0",
      stratum: { host: "pearlerpool.com", port_plain: 3334, port_tls: 4444, protocol: "stratum-pearl/v0.1" },
      economics: { fee_bps: 100, payout_scheme: "PPLNS", pplns_window_shares: 10000 },
      verification: { canonical_verify: true },
      payout_address_format: "prl1...",
      pool_payout_address: "prl1ps04hu7s8nzmn3t7mdf8c6jwtk7pzfxw4p7p6avxge367a8xnfzcq7c26dk"
    };
    if (path === "/stats") return {
      pool: "p²", version: "0.1.0",
      job: { job_id: "a6506410", height: 79775, reward_grains: 256236503863, age_ms: 109829 },
      stratum: { sessions: 72, accepted: 305898, rejected: 12 },
      shares_total: 1821809,
      submissions: { attempted: 2, accepted: 2, rejected: 0, orphaned: 0, last_height: 79593 }
    };
    if (path === "/miners") return { top_miners: sampleMiners() };
    if (path.indexOf("/miners/") === 0) return sampleMiner(decodeURIComponent(path.slice(8)));
    if (path === "/pool/blocks") return sampleBlocks();
    return null;
  }
  function sampleMiners() {
    var out = [];
    for (var i = 0; i < 8; i++) out.push({
      payout_addr: "prl1" + Math.random().toString(36).slice(2, 10) + "q7c26dk",
      rewards: { payed: Math.floor(Math.random() * 9e11), pending: Math.floor(Math.random() * 8e10) }
    });
    out.sort(function (a, b) { return (b.rewards.payed + b.rewards.pending) - (a.rewards.payed + a.rewards.pending); });
    return out;
  }
  function sampleMiner(addr) {
    var workers = [], names = ["rig-01", "gpu-a100", "rig-02"], n = 2 + Math.floor(Math.random() * 2);
    for (var i = 0; i < n; i++) workers.push({ name: names[i] || ("worker-" + i), shares: Math.floor(20000 + Math.random() * 400000), last_share: Date.now() - Math.floor(Math.random() * 600000) });
    return { payout_addr: addr, workers: workers, rewards: { payed: Math.floor(Math.random() * 6e11), pending: Math.floor(Math.random() * 5e10) } };
  }
  function sampleBlocks() {
    var arr = [], h = 79593, st = ["ACCEPTED", "ACCEPTED", "ORPHAN"];
    for (var i = 0; i < 8; i++) arr.push({ block_height: h - i * 30, block_hash: "0x" + Math.random().toString(16).slice(2, 10) + "…", block_reward: 256236503863, worker_name: ["rig-01", "gpu-a100"][i % 2], miner_address: "prl1" + Math.random().toString(36).slice(2, 8) + "…dk", submit_status: st[i % st.length] });
    return arr;
  }

  /* ---------- shape-tolerant list extractors ---------- */
  function topMiners(d) { if (!d) return []; if (Array.isArray(d)) return d; return d.top_miners || d.miners || []; }
  function blockList(d) { if (!d) return []; if (Array.isArray(d)) return d; return d.blocks || d.data || []; }
  function workerList(d) { if (!d) return []; return d.workers || []; }

  /* ---------- formatters ---------- */
  function num(n) { if (n == null || isNaN(n)) return "—"; return Number(n).toLocaleString("en-US"); }
  function grainsToPRL(g) { if (g == null || isNaN(g)) return "—"; var v = Number(g) / GRAINS_PER_PRL; return v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 6 : 2 }); }
  function addrShort(a) { if (!a) return "—"; return a.length > 16 ? a.slice(0, 8) + "…" + a.slice(-6) : a; }
  function wname(n) { if (!n) return "—"; n = String(n); return n.length > 22 ? n.slice(0, 12) + "…" + n.slice(-6) : n; }
  function ago(ts) { if (!ts) return "—"; var t = typeof ts === "string" ? Date.parse(ts) : Number(ts); if (isNaN(t)) return "—"; var s = Math.max(0, Math.floor((Date.now() - t) / 1000)); if (s < 60) return s + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }

  /* ---------- ui helpers ---------- */
  function countUp(el, target, opts) {
    opts = opts || {}; var dur = 900, start = performance.now();
    function step(now) { var p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3), v = Math.floor(target * e); el.textContent = opts.format ? opts.format(v) : v.toLocaleString("en-US"); if (p < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  function copy(text, btn) { navigator.clipboard.writeText(text).then(function () { if (!btn) return; var o = btn.textContent; btn.textContent = "COPIED"; btn.classList.add("done"); setTimeout(function () { btn.textContent = o; btn.classList.remove("done"); }, 1600); }); }
  function mockNotice() {
    if (!PP.usingMock || document.getElementById("pp-mock")) return;
    var d = document.createElement("div");
    d.id = "pp-mock";
    d.style.cssText = "position:fixed;bottom:14px;left:14px;z-index:50;font-size:10px;letter-spacing:1px;color:#727884;border:1px solid rgba(233,230,221,.14);background:rgba(7,9,14,.85);padding:7px 11px";
    d.textContent = "⚠ SAMPLE DATA — pool API not reachable";
    document.body.appendChild(d);
  }
  function rain(id) {
    var c = document.getElementById(id); if (!c) return; var x = c.getContext("2d"), fs = 14, cols, drops, frame = 0, rb = "#07090e", rc = "233,230,221";
    function read() { var s = getComputedStyle(document.documentElement); rb = (s.getPropertyValue("--rain-bg") || "#07090e").trim() || "#07090e"; rc = (s.getPropertyValue("--rain-ch") || "233,230,221").trim() || "233,230,221"; }
    function bg() { x.globalAlpha = 1; x.fillStyle = rb; x.fillRect(0, 0, c.width, c.height); }
    function size() { c.width = innerWidth; c.height = innerHeight; cols = Math.ceil(c.width / (fs * 1.5)); drops = []; for (var i = 0; i < cols; i++) drops[i] = Math.random() * c.height / fs; bg(); }
    read(); size(); addEventListener("resize", size);
    addEventListener("pp-theme", function () { read(); bg(); });
    (function loop() { requestAnimationFrame(loop); frame++; if (frame % 2) return; x.globalAlpha = 0.12; x.fillStyle = rb; x.fillRect(0, 0, c.width, c.height); x.globalAlpha = 1; x.font = "400 " + fs + 'px "IBM Plex Mono",monospace'; for (var i = 0; i < cols; i++) { var ch = Math.random() < .5 ? "0" : "1", px = i * fs * 1.5, py = drops[i] * fs, b = Math.random() < .02; x.fillStyle = "rgba(" + rc + "," + (b ? .4 : .06) + ")"; x.fillText(ch, px, py); if (py > c.height && Math.random() > .975) drops[i] = 0; drops[i] += .3; } })();
  }

  PP.api = api; PP.apiRaw = apiRaw; PP.job = job; PP.subs = subs; PP.blocksFound = blocksFound; PP.activeMiners = activeMiners;
  PP.feePct = feePct; PP.rewardPRL = rewardPRL; PP.poolHashrate = poolHashrate; PP.minerHashrate = minerHashrate; PP.pplnsWindow = pplnsWindow;
  PP.topMiners = topMiners; PP.blockList = blockList; PP.workerList = workerList;
  PP.num = num; PP.grainsToPRL = grainsToPRL; PP.addrShort = addrShort; PP.wname = wname; PP.ago = ago;
  PP.countUp = countUp; PP.copy = copy; PP.mockNotice = mockNotice; PP.rain = rain; PP.netApi = netApi;

  /* ---------- dark / light theme toggle ---------- */
  function initTheme() {
    var KEY = "pp-theme", root = document.documentElement;
    try { if (localStorage.getItem(KEY) === "light") root.setAttribute("data-theme", "light"); } catch (e) {}
    var links = document.querySelector(".nav-links");
    if (!links || document.getElementById("theme-btn")) return;
    var btn = document.createElement("button");
    btn.id = "theme-btn"; btn.type = "button"; btn.className = "theme-toggle";
    btn.setAttribute("aria-label", "Toggle light and dark mode");
    function label() { btn.textContent = root.getAttribute("data-theme") === "light" ? "◑ DARK" : "◐ LIGHT"; }
    label();
    btn.addEventListener("click", function () {
      var light = root.getAttribute("data-theme") === "light";
      if (light) { root.removeAttribute("data-theme"); try { localStorage.setItem(KEY, "dark"); } catch (e) {} }
      else { root.setAttribute("data-theme", "light"); try { localStorage.setItem(KEY, "light"); } catch (e) {} }
      label(); dispatchEvent(new Event("pp-theme"));
    });
    var d = links.querySelector("a.discord");
    if (d) links.insertBefore(btn, d); else links.appendChild(btn);
  }
  PP.initTheme = initTheme;
  global.PP = PP;
  if (document.readyState !== "loading") initTheme();
  else document.addEventListener("DOMContentLoaded", initTheme);
})(window);
