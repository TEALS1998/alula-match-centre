// AlUla SC match centre: live updater.
// Runs on GitHub Actions every 10 minutes. Reads the Saudi Arabian Football Federation (SAFF)
// pages, updates site/data.js and leaves it untouched when anything looks wrong.
// Rules: never delete a match, never blank a score or venue, never guess a result.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "site", "data.js");
const RAW = path.join(ROOT, "raw");
const US = "العلا";
const URLS = {
  table: "https://www.saff.com.sa/championship.php?id=416",
  team: "https://saff.com.sa/team.php?id=121",
};
const FIRST_TEAM_SECTIONS = ["الدرجة الأولى", "كأس خادم الحرمين"];
const OTHER_SECTIONS = ["تحت", "السيدات", "الناشئات", "الصالات", "الشاطئية", "الرديف"];

const log = (...a) => console.log("[update]", ...a);

function diag(name, html) {
  if (!process.env.SAFF_DIAG) return;
  console.log(`[diag] ${name}: ${html.length} chars, <tr> ${(html.match(/<tr/gi)||[]).length}, العلا ${(html.match(/العلا/g)||[]).length}`);
  let i = -1, n = 0;
  for (const key of ["نقاط"]) { i = -1; n = 0;
    while ((i = html.indexOf(key, i + 1)) >= 0 && n < 3) { console.log(`[diag] ${name} @${key}#${n}: ` + html.slice(Math.max(0, i - 200), i + 900).replace(/\s+/g, " ")); n++; i += 2000; } }
}
async function get(url) {
  const r = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (AlUla SC match centre updater)",
      "accept-language": "ar,en;q=0.8",
    },
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // SAFF serves windows-1256 while declaring utf-8
  const utf = buf.toString("utf8");
  return /\uFFFD/.test(utf.slice(0, 20000)) ? new TextDecoder("windows-1256").decode(buf) : utf;
}

const decode = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
   .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const norm = (s) => s.replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
const num = (s) => { const d = s.replace(/[٠-٩]/g, (c) => "٠١٢٣٤٥٦٧٨٩".indexOf(c)); return /^-?\d+$/.test(d.trim()) ? +d : null; };

function loadData() {
  const src = fs.readFileSync(DATA, "utf8");
  const header = src.slice(0, src.indexOf("window.ALULA_DATA"));
  const window = {};
  new Function("window", src)(window);
  return { header, D: window.ALULA_DATA };
}
function saveData(header, D) {
  const out = header + "window.ALULA_DATA = " + JSON.stringify(D, null, 1) + ";\n";
  const check = {}; new Function("window", out)(check);
  if (!check.ALULA_DATA?.seasons?.[D.current]?.matches?.length) throw new Error("refusing to write a broken data.js");
  fs.writeFileSync(DATA, out);
}

// Map any team name on the page to the Arabic key used in data.js
function teamMatcher(D) {
  const keys = Object.keys(D.teams || {});
  const byNorm = new Map(keys.map((k) => [norm(k), k]));
  return (s) => {
    const n = norm(s).replace(/^نادي /, "");
    if (byNorm.has(n)) return byNorm.get(n);
    for (const [k, v] of byNorm) if (n === k || n.endsWith(" " + k) || n.startsWith(k + " ")) return v;
    return null;
  };
}

// ---------- standings ----------
function parseTable(html, teamOf) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(text).filter((c) => c !== "");
    const team = cells.map(teamOf).find(Boolean);
    const nums = cells.map(num).filter((n) => n !== null);
    if (!team || nums.length < 8) continue;
    // SAFF order: pos, played, won, drawn, lost, for, against, (diff?), points
    const [pos, p, w, d, l, gf, ga] = nums;
    const pts = nums[nums.length - 1];
    if (w + d + l !== p || w * 3 + d !== pts) continue; // sanity check
    rows.push([team, pos, pts, p, w, d, l, gf, ga]);
  }
  return rows;
}

// ---------- fixtures and results ----------
// SAFF fixture rows: cells fixture_td_1_<id> time, _2_ home, _3_ score or "-", _4_ away, _5_ venue.
// Dates come from calendar_date links, competitions from championship.php?id= headers.
function parseMatches(html, teamOf, defaultSection = "") {
  const re = /calendar_date=(\d{4}-\d{2}-\d{2})|championship\.php\?id=(\d+)['"][^>]*>([^<]+)<|id="fixture_td_(\d)_(\d+)"[^>]*>([\s\S]*?)<\/td>/g;
  let date = null, section = defaultSection;
  const fx = new Map();
  for (let m; (m = re.exec(html)); ) {
    if (m[1]) date = m[1];
    else if (m[2]) section = text(m[3]) + " #" + m[2];
    else {
      const id = m[5];
      if (!fx.has(id)) fx.set(id, { id, date, section, cells: {} });
      const cell = m[6];
      const tid = cell.match(/team\.php\?id=(\d+)/);
      fx.get(id).cells[m[4]] = { t: text(cell), tid: tid ? tid[1] : null };
    }
  }
  const out = [];
  for (const f of fx.values()) {
    const c = f.cells;
    if (!c[2] || !c[4] || !f.date) continue;
    const name = (x) => (x.tid === "121" ? US : teamOf(x.t));
    const home = name(c[2]), away = name(c[4]);
    if (!home || !away || (home !== US && away !== US)) continue;
    const tm = c[1] && c[1].t.match(/(\d{1,2}):(\d{2})/);
    const sc = c[3] && c[3].t.match(/^(\d{1,2})\s*-\s*(\d{1,2})/);
    out.push({ section: f.section, date: f.date, time: tm ? `${tm[1].padStart(2, "0")}:${tm[2]}` : null, home, away,
      scoreText: sc ? `${sc[1]}-${sc[2]}` : null, venue: c[5] ? c[5].t : null, saffId: f.id });
  }
  return out;
}
const firstTeam = (sec) => / #416$/.test(sec) || (FIRST_TEAM_SECTIONS.some((s) => sec.includes(s)) && !OTHER_SECTIONS.some((s) => sec.includes(s)));

const DAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], DAY_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const MON_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], MON_AR = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
const label = (date, time) => {
  const [y, m, d] = date.split("-").map(Number); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return [`${DAY_EN[wd]} ${d} ${MON_EN[m - 1]} ${y}${time ? " " + time : ""}`, `${DAY_AR[wd]} ${d} ${MON_AR[m - 1]}${time ? " " + time : ""}`];
};
const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

async function main() {
  const { header, D } = loadData();
  const S = D.seasons[D.current];
  const teamOf = teamMatcher(D);
  fs.mkdirSync(RAW, { recursive: true });
  const changes = [];
  let ok = 0;

  // Standings
  try {
    const html = await get(URLS.table);
    fs.writeFileSync(path.join(RAW, "championship.html"), html); diag("championship", html);
    const rows = parseTable(html, teamOf);
    if (rows.length >= 16 && rows.some((r) => r[0] === US)) {
      ok++;
      rows.sort((a, b) => a[1] - b[1]);
      if (JSON.stringify(rows) !== JSON.stringify(S.table.rows)) {
        const played = Math.max(...rows.map((r) => r[3]));
        S.table.rows = rows;
        S.table.asOfRound = played;
        const u = rows.find((r) => r[0] === US);
        S.standing = { pos: u[1], p: u[3], w: u[4], d: u[5], l: u[6], gf: u[7], ga: u[8], pts: u[2], asOfRound: played };
        changes.push(`table updated (AlUla ${u[1]}, ${u[2]} pts)`);
      }
      // Results listed on the league page
      for (const m of parseMatches(html, teamOf, "دوري الدرجة الأولى #416")) applyMatch(S, m, changes, true);
    } else log("standings not recognised, rows:", rows.length);
    if (process.env.SAFF_DIAG) log("table rows", JSON.stringify(rows.slice(0, 3)), "league page AlUla matches", JSON.stringify(parseMatches(html, teamOf, "#416").slice(-3)));
  } catch (e) { log("standings failed:", e.message); }

  // Fixtures and changes from the team page
  try {
    const html = await get(URLS.team);
    fs.writeFileSync(path.join(RAW, "team.html"), html); diag("team", html);
    const ms = parseMatches(html, teamOf).filter((m) => firstTeam(m.section));
    if (ms.length) ok++;
    for (const m of ms) applyMatch(S, m, changes, false);
    log("first team fixtures found:", ms.length);
    if (process.env.SAFF_DIAG) for (const m of ms) log("fx", m.date, m.time, m.home, m.scoreText || "v", m.away, "|", m.section, "|", m.venue);
  } catch (e) { log("team page failed:", e.message); }

  if (!ok) { log("no SAFF page could be read; data left unchanged"); process.exitCode = 0; return; }
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  D.lastChecked = today;
  saveData(header, D);
  fs.writeFileSync(path.join(ROOT, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), changes }, null, 1) + "\n");
  log(changes.length ? changes.join("; ") : "no changes");
}

function applyMatch(S, m, changes, fromLeaguePage) {
  const opp = m.home === US ? m.away : m.home;
  const cand = S.matches.filter((x) => (x.home === US ? x.away : x.home) === opp && x.home === m.home);
  // closest existing fixture with the same host and opponent
  let x = cand.sort((a, b) => days(a.date, m.date) - days(b.date, m.date))[0];
  if (x && days(x.date, m.date) > 75) x = null;
  let score = null;
  if (m.scoreText) { const [a, b] = m.scoreText.split(/[-:]/).map((s) => +s.trim()); if (a <= 20 && b <= 20) score = [a, b]; }
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  if (!x) {
    if (fromLeaguePage || m.date < today) return; // only add future fixtures from the team page
    const comp = m.section.includes("كأس") ? "cup" : "league";
    const id = "a" + m.date.replace(/-/g, "") + "_" + opp;
    if (S.matches.some((y) => y.id === id)) return;
    S.matches.push({ id, comp, round: null, date: m.date, time: m.time, home: m.home, away: m.away, venue: S.matches.find((y) => y.home === m.home)?.venue || null, status: "upcoming", score: null });
    changes.push(`new fixture ${m.home} v ${m.away} ${m.date}`);
    return;
  }
  if (score && x.status !== "played" && m.date <= today) {
    x.status = "played"; x.score = score;
    changes.push(`result ${x.home} ${score[0]} v ${score[1]} ${x.away}`);
    return;
  }
  if (x.status === "played") return;
  if (m.date !== x.date || (m.time && m.time !== x.time)) {
    const before = label(x.date, x.time), after = label(m.date, m.time || x.time);
    if (m.date !== x.date && !x.orig) x.orig = x.date;
    (x.changes ||= []).push({ field: m.date !== x.date ? "date" : "time", from: before, to: after });
    changes.push(`moved ${x.home} v ${x.away}: ${x.date} ${x.time || ""} to ${m.date} ${m.time || ""}`);
    x.date = m.date; if (m.time) x.time = m.time;
  }
}

export { parseTable, parseMatches, teamMatcher, applyMatch, firstTeam };
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname))
  main().catch((e) => { console.error(e); process.exitCode = 1; });
