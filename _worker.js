export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---------- helpers ----------
    const json = (data, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...extraHeaders,
        },
      });

    const html = (content, status = 200, extraHeaders = {}) =>
      new Response(content, {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...extraHeaders,
        },
      });

    const getCookie = (req, name) => {
      const c = req.headers.get("Cookie") || "";
      const m = c.match(new RegExp("(^|;\\s*)" + name + "=([^;]+)"));
      return m ? decodeURIComponent(m[2]) : null;
    };

    const setCookie = (name, value, opts = {}) => {
      const parts = [`${name}=${encodeURIComponent(value)}`];
      if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
      if (opts.path) parts.push(`Path=${opts.path}`);
      if (opts.httpOnly) parts.push("HttpOnly");
      if (opts.secure) parts.push("Secure");
      if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
      return parts.join("; ");
    };

    const readBodyJSON = async (req) => {
      try {
        return await req.json();
      } catch {
        return null;
      }
    };

    const makeId = () => {
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    const isoToday = () => {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

    const daysBetween = (fromISO, toISO) => {
      const a = new Date(fromISO + "T00:00:00Z").getTime();
      const b = new Date(toISO + "T00:00:00Z").getTime();
      return Math.floor((b - a) / (24 * 3600 * 1000));
    };

    // ---------- auth ----------
    const requireAuth = async () => {
      const token = getCookie(request, "sess");
      if (!token) return false;
      const ok = await env.VAULT.get(`sess:${token}`);
      return !!ok;
    };

    const ensureAuthedForAPI = async () => {
      const ok = await requireAuth();
      if (!ok) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      return null;
    };

    // ---------- storage ----------
    const INDEX_KEY = "index:records";
    const REC_KEY = (id) => `rec:${id}`;

    const readIndex = async () => {
      const raw = await env.VAULT.get(INDEX_KEY);
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    };

    const writeIndex = async (ids) => {
      await env.VAULT.put(INDEX_KEY, JSON.stringify(ids));
    };

    const readRecord = async (id) => {
      const raw = await env.VAULT.get(REC_KEY(id));
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const writeRecord = async (rec) => {
      await env.VAULT.put(REC_KEY(rec.id), JSON.stringify(rec));
    };

    const deleteRecord = async (id) => {
      await env.VAULT.delete(REC_KEY(id));
    };

    // ---------- APIs ----------
    if (path === "/api/login" && request.method === "POST") {
      const body = await readBodyJSON(request);
      const pass = body?.password || "";
      if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "CONFIG" }, 500);
      if (pass !== env.ADMIN_PASSWORD)
        return json({ ok: false, error: "INVALID" }, 401);

      const token = makeId() + makeId();
      await env.VAULT.put(`sess:${token}`, "1", {
        expirationTtl: 30 * 24 * 3600,
      });

      const cookie = setCookie("sess", token, {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAge: 30 * 24 * 3600,
      });

      return json({ ok: true }, 200, { "Set-Cookie": cookie });
    }

    if (path === "/api/logout" && request.method === "POST") {
      const token = getCookie(request, "sess");
      if (token) await env.VAULT.delete(`sess:${token}`);

      const cookie = setCookie("sess", "", {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAge: 0,
      });
      return json({ ok: true }, 200, { "Set-Cookie": cookie });
    }

    // list
    if (path === "/api/records" && request.method === "GET") {
      const unauthorized = await ensureAuthedForAPI();
      if (unauthorized) return unauthorized;

      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const status = (url.searchParams.get("status") || "all").trim(); // all|active|expired|soon
      const sort = (url.searchParams.get("sort") || "due").trim(); // due|updated|created|name

      const today = isoToday();
      const ids = await readIndex();

      const all = [];
      for (const id of ids) {
        const rec = await readRecord(id);
        if (!rec) continue;

        const start = rec.startDate || today;
        const unlimited = !!rec.unlimited;
        const storedEnd = rec.endDate || today;

        const ageDaysRaw = daysBetween(start, today);
        const ageDays = ageDaysRaw < 0 ? 0 : ageDaysRaw;

        let daysToEnd = null;
        let expired = false;
        let soon = false;

        if (!unlimited) {
          daysToEnd = daysBetween(today, storedEnd);
          expired = daysToEnd <= 0;
          soon = !expired && daysToEnd <= 7;
        }

        if (q) {
          const hay = [
            rec.name,
            rec.email,
            rec.password,
            rec.startDate,
            rec.endDate,
            rec.note,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!hay.includes(q)) continue;
        }

        if (status === "active" && expired) continue;
        if (status === "expired" && !expired) continue;
        if (status === "soon" && !soon) continue;

        all.push({ ...rec, daysToEnd, expired, soon, ageDays, unlimited });
      }

      all.sort((a, b) => {
        if (sort === "name")
          return (a.name || "").localeCompare(b.name || "");
        if (sort === "created")
          return (b.createdAt || "").localeCompare(a.createdAt || "");
        if (sort === "updated")
          return (b.updatedAt || "").localeCompare(a.updatedAt || "");
        // due
        if (a.expired !== b.expired) return a.expired ? -1 : 1;
        if ((a.endDate || "") !== (b.endDate || ""))
          return (a.endDate || "") < (b.endDate || "") ? -1 : 1;
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      });

      const stats = {
        total: all.length,
        expired: all.filter((r) => r.expired).length,
        soon: all.filter((r) => r.soon).length,
        active: all.filter((r) => !r.expired).length,
      };

      return json({ ok: true, today, stats, records: all });
    }

    // create
    if (path === "/api/records" && request.method === "POST") {
      const unauthorized = await ensureAuthedForAPI();
      if (unauthorized) return unauthorized;

      const body = await readBodyJSON(request);
      if (!body) return json({ ok: false, error: "BAD" }, 400);

      const startDateRaw = String(body.startDate || "").trim();
      const endDateRaw = String(body.endDate || "").trim();
      const unlimited = !!body.unlimited;

      if (!isISODate(startDateRaw))
        return json({ ok: false, error: "DATE" }, 400);

      let endDate = null;
      if (!unlimited) {
        if (!isISODate(endDateRaw))
          return json({ ok: false, error: "DATE" }, 400);
        if (endDateRaw < startDateRaw)
          return json({ ok: false, error: "RANGE" }, 400);
        endDate = endDateRaw;
      }

      const id = makeId();
      const ts = new Date().toISOString();

      const rec = {
        id,
        name: String(body.name || "").trim(),
        email: String(body.email || "").trim(),
        password: String(body.password || "").trim(),
        startDate: startDateRaw,
        endDate,
        unlimited,
        note: String(body.note || "").trim(),
        createdAt: ts,
        updatedAt: ts,
      };

      const ids = await readIndex();
      ids.unshift(id);
      await writeIndex(ids);
      await writeRecord(rec);

      return json({ ok: true, record: rec });
    }

    // update
    if (path.startsWith("/api/records/") && request.method === "PUT") {
      const unauthorized = await ensureAuthedForAPI();
      if (unauthorized) return unauthorized;

      const id = path.split("/").pop();
      if (!id) return json({ ok: false, error: "NOID" }, 400);

      const body = await readBodyJSON(request);
      if (!body) return json({ ok: false, error: "BAD" }, 400);

      const rec = await readRecord(id);
      if (!rec) return json({ ok: false, error: "NF" }, 404);

      const startDateRaw = String(body.startDate ?? rec.startDate ?? "")
        .trim();
      const endDateRaw = String(body.endDate ?? rec.endDate ?? "").trim();
      const unlimited =
        body.unlimited !== undefined ? !!body.unlimited : !!rec.unlimited;

      if (!isISODate(startDateRaw))
        return json({ ok: false, error: "DATE" }, 400);

      let endDate = null;
      if (!unlimited) {
        if (!isISODate(endDateRaw))
          return json({ ok: false, error: "DATE" }, 400);
        if (endDateRaw < startDateRaw)
          return json({ ok: false, error: "RANGE" }, 400);
        endDate = endDateRaw;
      }

      rec.name = String(body.name ?? rec.name ?? "").trim();
      rec.email = String(body.email ?? rec.email ?? "").trim();
      rec.password = String(body.password ?? rec.password ?? "").trim();
      rec.startDate = startDateRaw;
      rec.endDate = endDate;
      rec.unlimited = unlimited;
      rec.note = String(body.note ?? rec.note ?? "").trim();
      rec.updatedAt = new Date().toISOString();

      await writeRecord(rec);
      return json({ ok: true, record: rec });
    }

    // delete
    if (path.startsWith("/api/records/") && request.method === "DELETE") {
      const unauthorized = await ensureAuthedForAPI();
      if (unauthorized) return unauthorized;

      const id = path.split("/").pop();
      if (!id) return json({ ok: false, error: "NOID" }, 400);

      const ids = await readIndex();
      await writeIndex(ids.filter((x) => x !== id));
      await deleteRecord(id);

      return json({ ok: true });
    }

    // ---------- UI ----------
    const authed = await requireAuth();
    return html(renderPage({ authed, today: isoToday() }));
  },
};

function renderPage({ authed, today }) {
  const BRAND = "Thiha Aung (Yone Man)";
  return `<!doctype html>
<html lang="my">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>VaultBoard</title>
  <style>
    :root{
      --bg1:#030617;
      --bg2:#020617;
      --txt:#e5ecff;
      --mut:#94a3b8;

      --brand:#6366f1;
      --ok:#22c55e;
      --warn:#eab308;
      --bad:#ef4444;

      --shadow: 0 18px 40px rgba(15,23,42,.75);
      --r:14px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      /* plain dark background – no big tiles */
      background:#020617;
      color: var(--txt);
      min-height:100vh;
    }

    /* fixed topbar */
    .topbar{
      position: fixed;
      top: 12px;
      left: 16px;
      right: 16px;
      z-index: 50;
      max-width: 1250px;
      margin: 0 auto;
      border: 1px solid rgba(148,163,184,.45);
      background:
        linear-gradient(135deg, rgba(15,23,42,.96), rgba(15,23,42,.92));
      border-radius: var(--r);
      box-shadow: var(--shadow);
      padding: 12px;
      display:flex;
      gap:12px;
      align-items:center;
      justify-content:space-between;
    }
    @media (min-width: 1282px){
      .topbar{
        left: 50%;
        transform: translateX(-50%);
        right: auto;
        width: 1250px;
      }
    }
    @media (max-width: 700px){ .topbar{ flex-wrap: wrap; } }

    .wrap{
      max-width: 1250px;
      margin:0 auto;
      padding: 16px;
      padding-top: 130px;
    }
    @media (max-width: 700px){ .wrap{ padding-top: 198px; } }

    .brandBox{display:flex; gap:10px; align-items:center; min-width: 220px;}
    .logo{
      width:34px;height:34px;border-radius: 10px;
      background: conic-gradient(from 210deg, #22c55e, #22d3ee, #6366f1, #22c55e);
      box-shadow: 0 12px 28px rgba(56,189,248,.35);
      display:flex; align-items:center; justify-content:center;
      flex:none;
    }
    .brandBox b{display:block; font-size:14px; font-weight:950}
    .brandBox span{display:block; font-size:12px; color: var(--mut); margin-top:2px}

    .controls{
      display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end;
      width: 100%;
    }
    .controls .row{display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end; width:100%;}
    @media (min-width: 701px){
      .controls{width:auto}
      .controls .row{width:auto}
    }

    /* Search pill */
    .search{
      flex: 1;
      min-width: 280px;
      max-width: 620px;
      display:flex;
      align-items:center;
      gap:10px;
      border-radius: 999px;
      padding: 12px 16px;
      border:1px solid rgba(129,140,248,.75);
      background: radial-gradient(circle at top left,
                  rgba(15,23,42,.98),
                  rgba(15,23,42,.90));
      box-shadow: 0 10px 30px rgba(15,23,42,.75);
    }
    .search:focus-within{
      border-color: rgba(96,165,250,1);
      box-shadow:
        0 0 0 1px rgba(96,165,250,.85),
        0 12px 32px rgba(15,23,42,.9);
    }
    .searchIcon{
      width:18px;
      height:18px;
      flex:none;
      display:flex;
      align-items:center;
      justify-content:center;
      opacity:.9;
    }
    @media (max-width: 700px){
      .search{ min-width: 100%; max-width: 100%; }
    }
    .search input{
      width:100%;
      border:0;
      outline:none;
      background:transparent;
      color: var(--txt);
      font-size:14px;
    }
    .search input::placeholder{ color: var(--mut); }

    select, input, textarea{
      border:1px solid rgba(148,163,184,.40);
      background: rgba(15,23,42,.92);
      color: var(--txt);
      border-radius: 12px;
      padding:10px 12px;
      outline:none;
    }
    textarea{min-height:92px; resize:vertical}

    .btn{
      cursor:pointer;
      border:1px solid rgba(148,163,184,.45);
      background: rgba(15,23,42,.95);
      color: var(--txt);
      border-radius: 12px;
      padding:10px 12px;
      font-weight:900;
      white-space:nowrap;
      transition: background .15s, transform .12s, box-shadow .15s;
    }
    .btn:hover{ background: rgba(30,64,175,.95); transform: translateY(-1px); box-shadow: 0 10px 22px rgba(15,23,42,.7); }
    .btn.primary{
      border-color: rgba(129,140,248,.9);
      background: radial-gradient(circle at top left, rgba(56,189,248,.98), rgba(129,140,248,.98));
    }
    .btn.primary:hover{
      background: radial-gradient(circle at top left, rgba(59,130,246,1), rgba(129,140,248,1));
    }
    .btn.danger{ border-color: rgba(248,113,113,.8); background: rgba(127,29,29,.95); }
    .btn.small{ padding:8px 10px; font-size:12px; border-radius: 10px; }

    .muted{ color: var(--mut); }

    .grid{
      display:grid;
      grid-template-columns: 320px 1fr;
      gap: 14px;
      align-items:start;
    }
    @media (max-width: 980px){ .grid{ grid-template-columns: 1fr; } }

    .card{
      border: 1px solid rgba(148,163,184,.35);
      background: radial-gradient(circle at top left, rgba(30,64,175,.45), rgba(15,23,42,.98));
      border-radius: var(--r);
      box-shadow: var(--shadow);
      padding: 14px;
    }

    .side{ position: sticky; top: 140px; }
    @media (max-width: 980px){ .side{ display:none; } }

    .drawerBtn{ display:none; }
    @media (max-width: 980px){ .drawerBtn{ display:inline-block; } }

    .drawerBack{
      position: fixed;
      inset:0;
      background: rgba(15,23,42,.82);
      z-index: 80;
      display:none;
      padding: 14px;
    }
    .drawerBack.show{ display:block; }
    .drawer{
      max-width: 520px;
      height: calc(100vh - 28px);
      overflow:auto;
      background: radial-gradient(circle at top left, rgba(30,64,175,.5), rgba(15,23,42,.97));
      border: 1px solid rgba(148,163,184,.45);
      border-radius: var(--r);
      box-shadow: var(--shadow);
      padding: 14px;
    }

    .pill{
      display:inline-flex; flex-wrap:wrap; align-items:center; gap:6px;
      padding:8px 10px;
      border-radius: 999px;
      border:1px solid rgba(148,163,184,.5);
      background: radial-gradient(circle at top left, rgba(37,99,235,.5), rgba(15,23,42,.98));
      color: var(--txt);
      font-size:12px;
    }

    .stats{ display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    .stat{
      border:1px solid rgba(148,163,184,.35);
      background: rgba(15,23,42,.94);
      border-radius: 12px;
      padding: 12px;
    }
    .stat .k{ font-size:11px; color: var(--mut); text-transform:uppercase; letter-spacing:.08em; }
    .stat .v{ font-size:22px; font-weight:950; margin-top:2px; }

    .sectionTitle{
      font-size:12px;
      letter-spacing:.12em;
      color: var(--mut);
      font-weight:950;
      margin: 14px 0 10px 0;
      text-transform:uppercase;
    }
    .notifList{ display:flex; flex-direction:column; gap:10px; }
    .notif{
      border:1px solid rgba(148,163,184,.35);
      background: rgba(15,23,42,.96);
      border-radius: 12px;
      padding: 12px;
      display:flex; justify-content:space-between; gap:12px; align-items:flex-start;
    }
    .notif b{ font-size:13px; }
    .notif .sub{ font-size:12px; color: var(--mut); margin-top:4px; line-height:1.35; }

    .tag{
      display:inline-flex; align-items:center; gap:6px;
      padding:4px 8px; border-radius:999px;
      font-size:12px; border:1px solid rgba(148,163,184,.4);
      background: rgba(15,23,42,.98);
      font-weight:900;
    }
    .tag.ok{
      border-color: rgba(34,197,94,.75);
      background: rgba(22,163,74,.16);
    }
    .tag.warn{
      border-color: rgba(234,179,8,.75);
      background: rgba(234,179,8,.16);
    }
    .tag.bad{
      border-color: rgba(248,113,113,.85);
      background: rgba(127,29,29,.45);
    }

    .statusDot{
      width:10px;
      height:10px;
      border-radius:999px;
      display:inline-block;
      margin-right:4px;
      animation: dotPulse 1.3s ease-in-out infinite;
    }
    .dotBlue{ background:#38bdf8; box-shadow:0 0 10px rgba(56,189,248,.7); }
    .dotGreen{ background:#22c55e; box-shadow:0 0 10px rgba(34,197,94,.7); }
    .dotAmber{ background:#eab308; box-shadow:0 0 10px rgba(234,179,8,.7); }
    .dotRed{ background:#f97373; box-shadow:0 0 10px rgba(248,113,113,.8); }

    @keyframes dotPulse{
      0%{ transform:scale(1); opacity:.9; }
      50%{ transform:scale(1.6); opacity:.35; }
      100%{ transform:scale(1); opacity:.9; }
    }

    .head{
      display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap;
      margin-bottom: 10px;
    }
    .head b{ font-size:14px; font-weight:950; }

    .collapseRow{ display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .formGrid{ display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 640px){ .formGrid{ grid-template-columns: 1fr; } }
    label{ display:flex; flex-direction:column; gap:6px; font-size:12px; color: var(--mut); }
    .bar{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 12px; }

    .tableWrap{
      border:1px solid rgba(148,163,184,.4);
      background: rgba(15,23,42,.98);
      border-radius: 12px;
      overflow:auto;
      padding:4px;
    }
    table{
      width:100%;
      min-width:1150px;
      border-collapse:separate;
      border-spacing:0 6px;
    }
    th, td{
      padding: 10px 10px;
      vertical-align: top;
      font-size:13px;
    }
    th{
      position: sticky;
      top: 0;
      background: radial-gradient(circle at top left, rgba(37,99,235,.8), rgba(15,23,42,.98));
      text-align:left;
      font-size:12px;
      color: var(--mut);
      z-index: 2;
      border-bottom:none;
    }
    th .thLabel{
      display:inline-block;
      padding:4px 8px;
      border-radius:8px;
      border:1px solid rgba(148,163,184,.55);
      background:rgba(15,23,42,.96);
      color:var(--mut);
    }

    tbody tr td{
      border-bottom:none;
      background: rgba(15,23,42,.97);
    }
    tbody tr td:first-child{
      border-top-left-radius:10px;
      border-bottom-left-radius:10px;
    }
    tbody tr td:last-child{
      border-top-right-radius:10px;
      border-bottom-right-radius:10px;
    }
    tbody tr:hover td{
      background: radial-gradient(circle at top left, rgba(37,99,235,.65), rgba(15,23,42,.98));
    }

    .pwd{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    .num{ width: 52px; color: var(--mut); font-weight:950; white-space:nowrap; }
    .nameCell, .nowrap{
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      max-width: 260px;
    }

    .noteSmall{
      font-size:12px;
      color: var(--mut);
      line-height:1.35;
      max-width: 320px;
    }

    /* container for multiple chips */
    .noteBox{
      display:flex;
      flex-wrap:wrap;
      gap:4px;
    }
    .noteChip{
      display:inline-block;
      padding:4px 7px;
      border-radius:8px;
      border:1px solid rgba(148,163,184,.55);
      background:rgba(15,23,42,.97);
    }

    /* pill for cell content */
    .cellPill{
      display:inline-flex;
      align-items:center;
      padding:4px 10px;
      border-radius:999px;
      border:1px solid rgba(148,163,184,.55);
      background:rgba(15,23,42,.96);
      font-size:12px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      max-width:100%;
    }
    .cellPillSlim{
      padding-inline:8px;
    }

    .miniBtns{ display:flex; gap:8px; flex-wrap:wrap; }
    .miniBtns button{
      padding:8px 10px;
      border-radius:10px;
      border:1px solid rgba(148,163,184,.45);
      background: rgba(15,23,42,.96);
      color: var(--txt);
      cursor:pointer;
      font-weight:900;
      font-size:12px;
    }
    .miniBtns button:hover{ background: rgba(30,64,175,.9); }
    .miniBtns .primary{
      border-color: rgba(99,102,241,.7);
      background: linear-gradient(135deg, rgba(99,102,241,.95), rgba(56,189,248,.9));
    }
    .miniBtns .danger{ border-color: rgba(248,113,113,.75); background: rgba(127,29,29,.9); }

    .datePill{
      display:inline-block;
      padding:4px 8px;
      border-radius:8px;
      border:1px solid rgba(148,163,184,.55);
      background:rgba(15,23,42,.96);
      font-size:12px;
      color:var(--txt);
      white-space:nowrap;
    }

    .toast{
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 200;
      border:1px solid rgba(148,163,184,.45);
      background: rgba(15,23,42,.98);
      border-radius: 12px;
      box-shadow: var(--shadow);
      padding: 12px 14px;
      min-width: 260px;
      display:none;
    }
    .toast.show{ display:block; }

    .loginWrap{
      max-width: 520px;
      margin: 12vh auto 0 auto;
      padding: 18px;
      border:1px solid rgba(148,163,184,.45);
      background: radial-gradient(circle at top left, rgba(30,64,175,.65), rgba(15,23,42,.96));
      border-radius: 14px;
      box-shadow: var(--shadow);
    }
    .loginWrap h1{ margin:0 0 6px 0; font-size: 20px; }
    .loginWrap p{ margin:0 0 14px 0; color: var(--mut); }
    .loginRow{ display:flex; gap:10px; }
    .loginRow input{ flex: 1; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brandBox">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
          <path d="M12 2l8 4v6c0 5-3.4 9.4-8 10-4.6-.6-8-5-8-10V6l8-4z"
                stroke="rgba(15,23,42,1)" stroke-width="1.6"/>
          <path d="M8.5 12.3l2.1 2.1 4.9-5.1"
                stroke="rgba(15,23,42,1)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div>
        <b>VaultBoard</b>
        <span>${BRAND} • Password & expiry dashboard</span>
      </div>
    </div>

    ${
      authed
        ? `
    <div class="controls">
      <div class="row">
        <button class="btn small drawerBtn" id="openDrawerBtn">Menu</button>

        <div class="search" title="Search">
          <span class="searchIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <circle cx="11" cy="11" r="6.5"
                      stroke="rgba(148,163,184,0.9)" stroke-width="1.6"></circle>
              <path d="M15.5 15.5L19.5 19.5"
                    stroke="rgba(148,163,184,0.9)" stroke-width="1.6"
                    stroke-linecap="round"></path>
            </svg>
          </span>
          <input id="search" placeholder="Search name / email / password / date / note..." />
        </div>

        <select id="status" title="Filter">
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="soon">Expiring (≤7d)</option>
          <option value="expired">Expired</option>
        </select>

        <select id="sort" title="Sort">
          <option value="due">Sort: End date</option>
          <option value="updated">Sort: Updated</option>
          <option value="created">Sort: Created</option>
          <option value="name">Sort: Name</option>
        </select>

        <button class="btn small" id="hideAllBtn">Hide</button>
        <button class="btn small" id="showAllBtn">Show</button>
        <button class="btn small primary" id="newBtn">+ New</button>
        <button class="btn small" id="refreshBtn">Refresh</button>
        <button class="btn small danger" id="logoutBtn">Logout</button>
      </div>
    </div>
        `
        : ``
    }
  </div>

  <div class="wrap">
    ${
      authed
        ? `
    <div class="grid">
      <aside class="card side">
        <div class="pill" id="todayPill"></div>

        <div class="stats">
          <div class="stat"><div class="k">Total</div><div class="v" id="st_total">-</div></div>
          <div class="stat"><div class="k">Active</div><div class="v" id="st_active">-</div></div>
          <div class="stat"><div class="k">Expiring</div><div class="v" id="st_soon">-</div></div>
          <div class="stat"><div class="k">Expired</div><div class="v" id="st_expired">-</div></div>
        </div>

        <div class="sectionTitle">NOTIFICATIONS</div>
        <div class="notifList" id="notifList"></div>
        <div class="muted" style="font-size:12px; margin-top:10px" id="notifHint"></div>
      </aside>

      <div class="drawerBack" id="drawerBack">
        <div class="drawer">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px">
            <div class="sectionTitle" style="margin:0">Menu</div>
            <button class="btn small" id="closeDrawerBtn">Close</button>
          </div>

          <div class="pill" style="margin-top:12px" id="todayPill2"></div>

          <div class="stats">
            <div class="stat"><div class="k">Total</div><div class="v" id="st_total2">-</div></div>
            <div class="stat"><div class="k">Active</div><div class="v" id="st_active2">-</div></div>
            <div class="stat"><div class="k">Expiring</div><div class="v" id="st_soon2">-</div></div>
            <div class="stat"><div class="k">Expired</div><div class="v" id="st_expired2">-</div></div>
          </div>

          <div class="sectionTitle">NOTIFICATIONS</div>
          <div class="notifList" id="notifList2"></div>
          <div class="muted" style="font-size:12px; margin-top:10px" id="notifHint2"></div>
        </div>
      </div>

      <main style="display:flex; flex-direction:column; gap:14px">
        <div class="card">
          <div class="head">
            <div>
              <b>Records</b>
            </div>
          </div>

          <div class="collapseRow" style="margin: 8px 0 12px 0">
            <div class="muted" style="font-size:12px" id="modeHint">Add mode</div>
            <button class="btn small" id="toggleFormBtn">Show form</button>
          </div>

          <div id="formArea" style="display:none">
            <div class="formGrid">
              <label>Name
                <input id="f_name" placeholder="name" />
              </label>
              <label>Email
                <input id="f_email" placeholder="email" />
              </label>
              <label>Password
                <input id="f_password" class="pwd" placeholder="password" />
              </label>
              <label>Start Date
                <input id="f_start" type="date" />
              </label>
              <label>End Date
                <input id="f_end" type="date" />
              </label>
              <label>Days Range
                <input id="f_days" type="number" min="0" placeholder="e.g. 30" />
              </label>
            </div>

            <div style="margin-top:6px">
              <label style="flex-direction:row;align-items:center;gap:8px;font-size:12px;color:var(--mut)">
                <input type="checkbox" id="f_unlimited" style="width:auto;margin:0">
                <span>Unlimited (no end date)</span>
              </label>
            </div>

            <div style="margin-top:12px">
              <label>Note / မှတ်ချက်
                <textarea id="f_note" placeholder="notes..."></textarea>
              </label>
            </div>

            <div class="bar">
              <button class="btn primary" id="saveBtn">Save</button>
              <button class="btn" id="clearBtn">Clear</button>
            </div>

            <div style="height:12px"></div>
          </div>

          <div class="tableWrap">
            <table>
              <thead>
                <tr>
                  <th><span class="thLabel">No.</span></th>
                  <th><span class="thLabel">Status</span></th>
                  <th><span class="thLabel">Name</span></th>
                  <th><span class="thLabel">Email</span></th>
                  <th><span class="thLabel">Password</span></th>
                  <th><span class="thLabel">Start</span></th>
                  <th><span class="thLabel">End</span></th>
                  <th><span class="thLabel">Days</span></th>
                  <th><span class="thLabel">Note</span></th>
                  <th><span class="thLabel">Actions</span></th>
                </tr>
              </thead>
              <tbody id="tbody"></tbody>
            </table>
          </div>

          <div class="muted" style="font-size:12px; margin-top:10px">
            Password default hidden • Show/Hide + Copy per row
          </div>
        </div>
      </main>
    </div>

    <div class="toast" id="toast">
      <b id="toastTitle"></b>
      <div class="muted" id="toastMsg"></div>
    </div>

    <script>
      const state = {
        records: [],
        editingId: null,
        showPw: new Set(),
        formOpen: false,
      };

      const el = (id)=>document.getElementById(id);

      function toast(title, msg){
        el('toastTitle').textContent = title;
        el('toastMsg').textContent = msg || '';
        el('toast').classList.add('show');
        setTimeout(()=> el('toast').classList.remove('show'), 2300);
      }

      function escapeHtml(s){
        return String(s ?? '')
          .replaceAll('&','&amp;')
          .replaceAll('<','&lt;')
          .replaceAll('>','&gt;')
          .replaceAll('"','&quot;')
          .replaceAll("'","&#039;");
      }

      function masked(pw){
        if(!pw) return '';
        const n = Math.max(6, Math.min(14, pw.length));
        return '•'.repeat(n);
      }

      function maskEmail(addr){
        addr = String(addr || '');
        if(!addr) return '';
        const at = addr.indexOf('@');
        if(at === -1) return '••••';
        const name = addr.slice(0, Math.min(3, at));
        const domain = addr.slice(at);
        return name + '••••' + domain;
      }

      // ISO date -> "20.1.2026"
      function formatDisplayDate(iso){
        iso = String(iso || '').trim();
        if(!iso) return '';
        if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(iso)) return iso;
        const [y, m, d] = iso.split('-');
        const dd = parseInt(d,10);
        const mm = parseInt(m,10);
        return dd + '.' + mm + '.' + y;
      }

      // note 1 / note 2 / note 3 ကို box သီးသန့်လုပ်ပေးမယ့် helper
      function renderNoteHTML(note){
        const parts = String(note || '')
          .split(/\\r?\\n/)
          .map(s => s.trim())
          .filter(Boolean);
        if(!parts.length) return '';
        return parts
          .map(line => '<span class="noteChip">' + escapeHtml(line) + '</span>')
          .join('');
      }

      function statusTag(r){
        const unlimited = !!r.unlimited;
        if(unlimited){
          return '<span class="tag"><span class="statusDot dotBlue"></span>UNLIMITED</span>';
        }
        if(r.expired){
          return '<span class="tag bad"><span class="statusDot dotRed"></span>EXPIRED</span>';
        }
        const days = r.daysToEnd;
        if(typeof days === 'number'){
          if(days <= 3){
            return '<span class="tag bad"><span class="statusDot dotRed"></span>EXPIRING</span>';
          }
          if(days <= 7){
            return '<span class="tag warn"><span class="statusDot dotAmber"></span>SOON</span>';
          }
        }
        return '<span class="tag ok"><span class="statusDot dotGreen"></span>ACTIVE</span>';
      }

      async function copyText(label, value){
        try{
          if(!value){ toast('Nothing to copy', label + ' is empty'); return; }
          await navigator.clipboard.writeText(value);
          toast('Copied', label + ' copied');
        }catch(e){
          toast('Copy failed', 'Browser permission');
        }
      }

      function setMode(editing){
        el('modeHint').textContent = editing ? ('Editing: ' + state.editingId) : 'Add mode';
      }

      function setForm(open){
        state.formOpen = open;
        el('formArea').style.display = open ? 'block' : 'none';
        el('toggleFormBtn').textContent = open ? 'Hide form' : 'Show form';
      }

      function daysBetweenLocal(fromISO, toISO){
        const a = new Date(fromISO + "T00:00:00Z").getTime();
        const b = new Date(toISO + "T00:00:00Z").getTime();
        return Math.floor((b - a) / (24 * 3600 * 1000));
      }

      function addDays(iso, days){
        const d = new Date(iso + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0,10);
      }

      function syncRange(trigger){
        const start = el('f_start').value;
        const end = el('f_end').value;
        const unlimited = el('f_unlimited').checked;
        const daysStr = el('f_days').value;

        if(unlimited){
          el('f_end').value = '';
          el('f_days').value = '';
          return;
        }

        if(trigger === 'days'){
          if(!start || daysStr === '') return;
          const d = parseInt(daysStr,10);
          if(Number.isNaN(d)) return;
          el('f_end').value = addDays(start, d);
        }else{
          if(!start || !end){
            if(trigger === 'start' && daysStr){
              const d = parseInt(daysStr,10);
              if(!Number.isNaN(d)) el('f_end').value = addDays(start, d);
            }else{
              el('f_days').value = '';
            }
            return;
          }
          const diff = daysBetweenLocal(start, end);
          el('f_days').value = isNaN(diff) ? '' : diff;
        }
      }

      function fillForm(rec){
        const unlimited = !!(rec && rec.unlimited);
        el('f_unlimited').checked = unlimited;

        el('f_name').value = rec?.name || '';
        el('f_email').value = rec?.email || '';
        el('f_password').value = rec?.password || '';
        el('f_start').value = rec?.startDate || '';
        el('f_end').value = unlimited ? '' : (rec?.endDate || '');
        el('f_note').value = rec?.note || '';

        if(!unlimited && rec?.startDate && rec?.endDate){
          const d = daysBetweenLocal(rec.startDate, rec.endDate);
          el('f_days').value = isNaN(d) ? '' : d;
        }else{
          el('f_days').value = '';
        }
        syncRange(unlimited ? 'unlimited' : 'start');
      }

      function renderStats(stats){
        el('st_total').textContent = stats?.total ?? '-';
        el('st_active').textContent = stats?.active ?? '-';
        el('st_soon').textContent = stats?.soon ?? '-';
        el('st_expired').textContent = stats?.expired ?? '-';

        if(el('st_total2')){
          el('st_total2').textContent = stats?.total ?? '-';
          el('st_active2').textContent = stats?.active ?? '-';
          el('st_soon2').textContent = stats?.soon ?? '-';
          el('st_expired2').textContent = stats?.expired ?? '-';
        }
      }

      function renderTable(){
        const tbody = el('tbody');
        tbody.innerHTML = '';

        state.records.forEach((r, idx) => {
          const tr = document.createElement('tr');
          tr.id = 'row-' + r.id;

          const shown = state.showPw.has(r.id);
          const pwText = shown ? (r.password || '') : masked(r.password || '');
          const pwBtn = shown ? 'Hide' : 'Show';
          const emailMasked = maskEmail(r.email || '');
          const isUnlimited = !!r.unlimited;

          const startFmt = formatDisplayDate(r.startDate || '');
          const endFmt = isUnlimited ? 'UNLIMITED' : formatDisplayDate(r.endDate || '');

          let daysText = '';
          if(isUnlimited){
            daysText = (r.ageDays ?? '') !== '' ? (r.ageDays + ' day(s) used') : '';
          }else{
            daysText = (r.daysToEnd ?? '') !== '' ? (r.daysToEnd + ' day(s) left') : '';
          }

          tr.innerHTML = \`
            <td class="num">\${idx + 1}</td>
            <td>\${statusTag(r)}</td>
            <td class="nameCell"><span class="cellPill">\${escapeHtml(r.name || '')}</span></td>
            <td class="nowrap"><span class="cellPill cellPillSlim">\${escapeHtml(emailMasked)}</span></td>
            <td class="pwd"><span class="cellPill cellPillSlim">\${escapeHtml(pwText)}</span></td>
            <td><span class="datePill">\${escapeHtml(startFmt)}</span></td>
            <td><span class="datePill">\${escapeHtml(endFmt)}</span></td>
            <td><span class="cellPill cellPillSlim">\${escapeHtml(String(daysText))}</span></td>
            <td class="noteSmall"><div class="noteBox">\${renderNoteHTML(r.note)}</div></td>
            <td>
              <div class="miniBtns">
                <button class="primary" onclick="startEdit('\${r.id}')">Edit</button>
                <button onclick="togglePw('\${r.id}')">\${pwBtn}</button>
                <button onclick="copyEmail('\${r.id}')">Copy Email</button>
                <button onclick="copyPassword('\${r.id}')">Copy Password</button>
                <button class="danger" onclick="delRec('\${r.id}')">Delete</button>
              </div>
            </td>
          \`;
          tbody.appendChild(tr);
        });
      }

      function renderNotifs(){
        const expiring = state.records.filter(r => r.soon && !r.expired);
        const expired = state.records.filter(r => r.expired);
        const alertsCount = expiring.length + expired.length;

        const draw = (listEl, hintEl) => {
          listEl.innerHTML = '';
          if(alertsCount === 0){
            hintEl.textContent = 'No alerts.';
            return;
          }
          hintEl.textContent = expiring.length + ' expiring • ' + expired.length + ' expired';

          const renderItem = (r, type) => {
            const isExpired = type === 'expired';
            const cls = isExpired ? 'bad' : 'warn';
            const label = isExpired ? 'Expired' : 'Expiring';
            const endLabel = formatDisplayDate(r.endDate || '');

            const div = document.createElement('div');
            div.className = 'notif';
            div.innerHTML = \`
              <div>
                <b>\${escapeHtml(r.name || '(no name)')}
                  <span class="tag \${cls}" style="margin-left:8px">\${label}</span>
                </b>
                <div class="sub">
                  End:
                  <span class="datePill">\${escapeHtml(endLabel)}</span>
                  • Days: \${escapeHtml(String(r.daysToEnd))}
                </div>
                <div class="sub">\${renderNoteHTML(r.note)}</div>
              </div>
              <div>
                <button class="btn small primary" onclick="jumpTo('\${r.id}')">Open</button>
              </div>
            \`;
            listEl.appendChild(div);
          };

          expiring.forEach(r => renderItem(r, 'soon'));
          expired.forEach(r => renderItem(r, 'expired'));
        };

        draw(el('notifList'), el('notifHint'));
        if(el('notifList2')) draw(el('notifList2'), el('notifHint2'));

        const menuBtn = el('openDrawerBtn');
        if(menuBtn){
          menuBtn.textContent = alertsCount ? ('Menu (' + alertsCount + ')') : 'Menu';
        }
      }

      async function load(){
        const q = el('search').value.trim();
        const status = el('status').value;
        const sort = el('sort').value;

        const res = await fetch('/api/records?q=' + encodeURIComponent(q)
          + '&status=' + encodeURIComponent(status)
          + '&sort=' + encodeURIComponent(sort));
        const data = await res.json();
        if(!data.ok){
          toast('Error', 'Please refresh or login again');
          return;
        }
        state.records = data.records || [];
        renderStats(data.stats);
        renderTable();
        renderNotifs();
      }

      async function save(){
        const payload = {
          name: el('f_name').value.trim(),
          email: el('f_email').value.trim(),
          password: el('f_password').value.trim(),
          startDate: el('f_start').value.trim(),
          endDate: el('f_end').value.trim(),
          note: el('f_note').value.trim(),
        };
        const unlimited = el('f_unlimited').checked;

        if(!payload.startDate){
          toast('Need dates', 'Start date is required');
          return;
        }
        if(!unlimited && !payload.endDate){
          toast('Need dates', 'End date is required (or mark Unlimited)');
          return;
        }
        if(!unlimited && payload.endDate < payload.startDate){
          toast('Invalid dates', 'End date must be after start date');
          return;
        }
        if(unlimited){
          payload.endDate = "";
        }
        payload.unlimited = unlimited;

        if(state.editingId){
          const res = await fetch('/api/records/' + state.editingId, {
            method:'PUT',
            headers:{'content-type':'application/json'},
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if(!data.ok){ toast('Update failed', 'Please try again'); return; }
          toast('Updated', 'Saved');
        } else {
          const res = await fetch('/api/records', {
            method:'POST',
            headers:{'content-type':'application/json'},
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if(!data.ok){ toast('Create failed', 'Please try again'); return; }
          toast('Saved', 'Created');
        }

        state.editingId = null;
        fillForm(null);
        setMode(false);
        setForm(false);
        await load();
      }

      window.startEdit = function(id){
        const rec = state.records.find(r => r.id === id);
        if(!rec){ toast('Not found', 'Missing record'); return; }
        state.editingId = id;
        fillForm(rec);
        setMode(true);
        setForm(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      window.delRec = async function(id){
        if(!confirm('Delete this record?')) return;
        const res = await fetch('/api/records/' + id, { method:'DELETE' });
        const data = await res.json();
        if(!data.ok){ toast('Delete failed', 'Please try again'); return; }
        state.showPw.delete(id);
        toast('Deleted', 'Removed');
        if(state.editingId === id){
          state.editingId = null;
          fillForm(null);
          setMode(false);
          setForm(false);
        }
        await load();
      }

      window.togglePw = function(id){
        if(state.showPw.has(id)) state.showPw.delete(id);
        else state.showPw.add(id);
        renderTable();
      }

      window.copyEmail = function(id){
        const r = state.records.find(x => x.id === id);
        if(!r) return toast('Not found', 'Missing record');
        copyText('Email', r.email || '');
      }

      window.copyPassword = function(id){
        const r = state.records.find(x => x.id === id);
        if(!r) return toast('Not found', 'Missing record');
        const ok = confirm('Copy password to clipboard? (Sensitive)');
        if(!ok) return;
        copyText('Password', r.password || '');
      }

      window.jumpTo = function(id){
        const row = document.getElementById('row-' + id);
        if(row){
          row.scrollIntoView({behavior:'smooth', block:'center'});
          row.style.transition = 'background 0.8s';
          row.style.background = 'rgba(30,64,175,.55)';
          setTimeout(()=> row.style.background = '', 1000);
          startEdit(id);
        } else {
          toast('Missing row', 'Try changing filter to All');
        }
      }

      async function logout(){
        await fetch('/api/logout', { method:'POST' });
        location.reload();
      }

      function clearForm(){
        state.editingId = null;
        fillForm(null);
        setMode(false);
        toast('Cleared', 'Form cleared');
      }

      function newRecord(){
        state.editingId = null;
        fillForm(null);
        setMode(false);
        setForm(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      function updateClock(){
        const d = new Date();

        const yyyy = d.getFullYear();
        const m = d.getMonth() + 1;
        const dd = d.getDate();
        const dateStr = dd + "ရက် " + m + "လ " + yyyy;

        const days = [
          "တနင်္ဂနွေ",
          "တနင်္လာ",
          "အင်္ဂါ",
          "ဗုဒ္ဓဟူး",
          "ကြာသပတေး",
          "သောကြာ",
          "စနေ"
        ];
        const dayName = days[d.getDay()] || "";

        let h = d.getHours();
        const mi = String(d.getMinutes()).padStart(2,"0");
        const ampm = h >= 12 ? "PM" : "AM";
        h = h % 12;
        if (h === 0) h = 12;
        const time12 = h + ":" + mi + " " + ampm;

        const html =
          dayName + " • <b>" + dateStr + "</b> · " +
          '<span style="font-weight:600">' + time12 + "</span>";

        const p1 = document.getElementById("todayPill");
        const p2 = document.getElementById("todayPill2");
        if (p1) p1.innerHTML = html;
        if (p2) p2.innerHTML = html;
      }

      el('saveBtn').addEventListener('click', save);
      el('clearBtn').addEventListener('click', clearForm);
      el('refreshBtn').addEventListener('click', load);
      el('logoutBtn').addEventListener('click', logout);
      el('newBtn').addEventListener('click', newRecord);

      el('toggleFormBtn').addEventListener('click', ()=> setForm(!state.formOpen));

      el('f_start').addEventListener('input', ()=> syncRange('start'));
      el('f_end').addEventListener('input', ()=> syncRange('end'));
      el('f_days').addEventListener('input', ()=> syncRange('days'));
      el('f_unlimited').addEventListener('change', ()=> syncRange('unlimited'));

      let t=null;
      const debounceLoad = ()=>{
        clearTimeout(t);
        t=setTimeout(load, 250);
      };
      el('search').addEventListener('input', debounceLoad);
      el('status').addEventListener('change', debounceLoad);
      el('sort').addEventListener('change', debounceLoad);

      el('hideAllBtn').addEventListener('click', ()=>{
        state.showPw.clear();
        renderTable();
        toast('Hidden', 'All passwords hidden');
      });
      el('showAllBtn').addEventListener('click', ()=>{
        for(const r of state.records) state.showPw.add(r.id);
        renderTable();
        toast('Shown', 'All passwords shown');
      });

      const back = el('drawerBack');
      const openBtn = el('openDrawerBtn');
      if(openBtn){
        openBtn.addEventListener('click', ()=> back.classList.add('show'));
        el('closeDrawerBtn').addEventListener('click', ()=> back.classList.remove('show'));
        back.addEventListener('click', (e)=>{ if(e.target === back) back.classList.remove('show'); });
      }

      const tdy = new Date().toISOString().slice(0,10);
      el('f_start').value = tdy;
      el('f_end').value = tdy;
      el('f_days').value = '';
      el('f_unlimited').checked = false;
      syncRange('start');
      setMode(false);
      setForm(false);
      load();
      updateClock();
      setInterval(updateClock, 60000);
    </script>
        `
        : `
    <div class="loginWrap">
      <h1>VaultBoard Login</h1>
      <p>Enter your admin password to access VaultBoard.</p>
      <div class="loginRow">
        <input id="pw" type="password" placeholder="Enter password..." />
        <button class="btn primary" id="loginBtn">Login</button>
      </div>
      <div class="muted" style="font-size:12px; margin-top:10px" id="loginHint"></div>
    </div>

    <div class="toast" id="toast">
      <b id="toastTitle"></b>
      <div class="muted" id="toastMsg"></div>
    </div>

    <script>
      const el = (id)=>document.getElementById(id);
      function toast(title, msg){
        document.getElementById('toastTitle').textContent = title;
        document.getElementById('toastMsg').textContent = msg || '';
        document.getElementById('toast').classList.add('show');
        setTimeout(()=> document.getElementById('toast').classList.remove('show'), 2300);
      }
      async function login(){
        const password = el('pw').value;
        if(!password){ toast('Need password', 'Password is required'); return; }
        el('loginHint').textContent = 'Signing in...';
        const res = await fetch('/api/login', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if(!data.ok){
          el('loginHint').textContent = '';
          toast('Login failed', 'Incorrect password');
          return;
        }
        location.reload();
      }
      el('loginBtn').addEventListener('click', login);
      el('pw').addEventListener('keydown', (e)=>{ if(e.key==='Enter') login(); });
    </script>
        `
    }
  </div>
</body>
</html>`;
}
