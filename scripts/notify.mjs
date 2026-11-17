// Sends a phone notification (ntfy) when a fixture changes: date, time, stadium, result,
// a new fixture, or the league position. Weather refreshes alone never notify.
// Usage: node scripts/notify.mjs <before-data.js> [after-data.js]
import fs from "node:fs";

const TOPIC = process.env.NTFY_TOPIC;
const SITE = "https://teals1998.github.io/alula-match-centre/";
const US = "العلا";

function load(file) {
  const window = {};
  new Function("window", fs.readFileSync(file, "utf8"))(window);
  return window.ALULA_DATA;
}
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const dAr = (iso) => {
  if (!iso) return "لم يُحدد";
  const d = new Date(iso + "T12:00:00Z");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const tAr = (t) => t || "لم يُحدد";
const label = (m) => {
  const opp = m.home === US ? m.away : m.home;
  const where = m.home === US ? "على أرضه" : "خارج أرضه";
  const comp = m.comp === "cup" ? "كأس الملك" : m.round ? `الجولة ${m.round}` : "الدوري";
  return `العلا ضد ${opp} (${comp}، ${where})`;
};
const result = (m) => {
  if (!m.score) return "";
  const [h, a] = m.score; const us = m.home === US ? h : a; const them = m.home === US ? a : h;
  const word = us > them ? "فاز العلا" : us < them ? "خسر العلا" : "تعادل العلا";
  return `${word} ${us} مقابل ${them}`;
};

export function diff(A, B) {
  const sa = A.seasons?.[A.current] || {}, sb = B.seasons?.[B.current] || {};
  const before = new Map((sa.matches || []).map((m) => [m.id, m]));
  const lines = [];
  let kind = new Set();
  for (const m of sb.matches || []) {
    const o = before.get(m.id);
    if (!o) { lines.push(`مباراة جديدة: ${label(m)}، ${dAr(m.date)} الساعة ${tAr(m.time)}`); kind.add("fixture"); continue; }
    const parts = [];
    if (o.date !== m.date) { parts.push(`الموعد من ${dAr(o.date)} إلى ${dAr(m.date)}`); kind.add("schedule"); }
    if ((o.time || null) !== (m.time || null)) { parts.push(`الوقت من ${tAr(o.time)} إلى ${tAr(m.time)}`); kind.add("schedule"); }
    if ((o.venue || null) !== (m.venue || null)) { parts.push(`الملعب من ${o.venue || "لم يُعلن"} إلى ${m.venue || "لم يُعلن"}`); kind.add("schedule"); }
    if (o.status !== m.status && m.status === "postponed") { parts.push("أُجّلت المباراة"); kind.add("schedule"); }
    if (JSON.stringify(o.score) !== JSON.stringify(m.score) && m.score) { parts.push(`النتيجة: ${result(m)}`); kind.add("result"); }
    if (parts.length) lines.push(`${label(m)}: ${parts.join("، ")}`);
  }
  const pa = sa.standing?.pos, pb = sb.standing?.pos;
  if (pa && pb && pa !== pb) { lines.push(`ترتيب العلا في الدوري: من المركز ${pa} إلى المركز ${pb}`); kind.add("table"); }
  return { lines, kind };
}

async function main() {
  const [beforeFile, afterFile = "site/data.js"] = process.argv.slice(2);
  if (beforeFile === "--test") return send("تجربة تنبيهات مركز مباريات العلا", "التنبيهات تعمل. ستصلك رسالة هنا عند أي تعديل في الجدول أو نتيجة جديدة.", 3);
  if (!beforeFile || !fs.existsSync(beforeFile)) { console.log("no earlier data to compare"); return; }
  const { lines, kind } = diff(load(beforeFile), load(afterFile));
  if (!lines.length) { console.log("nothing worth a notification"); return; }
  const title = kind.has("schedule") || kind.has("fixture") ? "تعديل في جدول مباريات العلا"
    : kind.has("result") ? "نتيجة جديدة لمباراة العلا" : "تحديث في مركز مباريات العلا";
  const message = lines.join("\n");
  console.log(title + "\n" + message);
  await send(title, message, kind.has("schedule") ? 4 : 3);
}
async function send(title, message, priority) {
  if (!TOPIC) { console.log("NTFY_TOPIC not set; notification not sent"); return; }
  const res = await fetch("https://ntfy.sh/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: TOPIC, title, message, click: SITE, priority, tags: ["soccer"] }),
  });
  console.log("ntfy:", res.status);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.log("notify failed:", e.message); });
