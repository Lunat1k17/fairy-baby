// Утреннее напоминание в Telegram: долги магазинов и «пора заказывать».
// Запускается GitHub Actions по расписанию. Секреты: FB_EMAIL, FB_PASSWORD, TG_TOKEN, TG_CHAT_ID.
const API_KEY = "AIzaSyAbZ04WARp1d0OITEqbVCbs22a89KIQNdc";
const PROJECT = "fairy-baby";
const SITE = "https://lunat1k17.github.io/fairy-baby/";
const env = process.env;
const ALWAYS = env.ALWAYS === "true";

const fmt = n => Math.round(n).toLocaleString("ru-RU").replace(/ | /g, " ");
const money = n => fmt(n) + " сум";
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
const fmtDate = s => s ? s.slice(8, 10) + "." + s.slice(5, 7) : "";
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Сегодня по Ташкенту (UTC+5)
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json(); if (!j.ok) throw new Error("Telegram: " + j.description); return j.result;
}

function val(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return obj(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  return null;
}
const obj = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)]));

async function loadData() {
  if (env.FIXTURE) return JSON.parse((await import("node:fs")).readFileSync(env.FIXTURE, "utf8"));
  const h = { "content-type": "application/json", referer: SITE };
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, { method: "POST", headers: h, body: JSON.stringify({ email: env.FB_EMAIL, password: env.FB_PASSWORD, returnSecureToken: true }) });
  const auth = await r.json(); if (!auth.idToken) throw new Error("Не удалось войти в Firebase: " + (auth.error && auth.error.message));
  const out = {};
  for (const name of ["products", "parties", "ops"]) {
    out[name] = []; let page = "";
    do {
      const u = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${name}?pageSize=300` + (page ? "&pageToken=" + encodeURIComponent(page) : "");
      const j = await (await fetch(u, { headers: { ...h, authorization: "Bearer " + auth.idToken } })).json();
      if (j.error) throw new Error("Firestore: " + j.error.message);
      for (const d of j.documents || []) out[name].push({ id: d.name.split("/").pop(), ...obj(d.fields || {}) });
      page = j.nextPageToken || "";
    } while (page);
  }
  return out;
}

function build(D) {
  const t = today();
  const opAmount = o => o.type === "sale" || o.type === "purchase" ? (o.qty || 0) * (o.price || 0) : (o.amount || 0);
  const debts = [];
  for (const p of D.parties.filter(p => p.kind !== "supplier")) {
    const mine = D.ops.filter(o => o.partyId === p.id);
    const items = mine.filter(o => o.type === "sale" || o.type === "debt_they").sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));
    let paid = mine.filter(o => o.type === "pay_in").reduce((a, o) => a + (o.amount || 0), 0);
    const total = items.reduce((a, o) => a + opAmount(o), 0) - paid;
    const open = [];
    for (const it of items) { const amt = opAmount(it), use = Math.min(paid, amt); paid -= use; if (amt - use > 0.5) open.push({ left: amt - use, due: it.dueDate || "" }); }
    const dated = open.filter(x => x.due).sort((a, b) => a.due.localeCompare(b.due));
    if (total <= 0.5 || !dated.length) continue;
    const days = daysBetween(t, dated[0].due);
    if (days > 2) continue;
    const lim = days <= 0 ? t : dated[0].due;
    debts.push({ name: p.name, phone: p.phone, days, due: dated[0].due, sum: Math.min(total, dated.filter(x => x.due <= lim).reduce((a, x) => a + x.left, 0)), total });
  }
  debts.sort((a, b) => a.days - b.days);
  const stock = id => D.ops.reduce((q, o) => o.productId !== id ? q : o.type === "purchase" ? q + (o.qty || 0) : o.type === "sale" ? q - (o.qty || 0) : q, 0);
  const low = D.products.filter(p => (p.minStock || 0) > 0 && stock(p.id) <= p.minStock).sort((a, b) => (a.order || 0) - (b.order || 0));

  const L = [];
  const groups = [["🔴 <b>Просрочено</b>", d => d.days < 0], ["🟠 <b>Сегодня срок</b>", d => d.days === 0], ["🟡 <b>Скоро срок</b>", d => d.days > 0]];
  for (const [title, fn] of groups) {
    const g = debts.filter(fn); if (!g.length) continue;
    L.push(title);
    for (const d of g) {
      const when = d.days < 0 ? `просрочен на ${-d.days} ${plural(-d.days, "день", "дня", "дней")}` : d.days === 0 ? "срок сегодня" : `срок ${fmtDate(d.due)}`;
      L.push(`• ${esc(d.name)}: <b>${money(d.sum)}</b> (${when}${d.total - d.sum > 0.5 ? ", весь долг " + money(d.total) : ""})${d.phone ? " " + esc(d.phone) : ""}`);
    }
    L.push("");
  }
  if (low.length) {
    L.push("📦 <b>Пора заказывать у Fairy Baby</b>");
    for (const p of low) { const q = stock(p.id); L.push(`• ${esc(p.name)}: ${q <= 0 ? "нет на складе" : "осталось " + fmt(q) + " пач."} (порог ${fmt(p.minStock)})`); }
    L.push("");
  }
  const has = L.length > 0;
  const head = `<b>Fairy Baby · ${fmtDate(t)}</b>`;
  const text = has ? [head, "", ...L, `<a href="${SITE}">Открыть сайт</a>`].join("\n") : `${head}\n\n✅ Сегодня нет долгов к оплате и все размеры в наличии.`;
  return { has, text };
}

async function main() {
  if (!env.FIXTURE) for (const k of ["FB_EMAIL", "FB_PASSWORD", "TG_TOKEN"]) if (!env[k]) throw new Error("Нет секрета " + k);
  if (!env.TG_CHAT_ID && !env.FIXTURE) {
    // Первый запуск: найти чат, где боту написали /start, и сообщить его номер.
    const ups = await tg("getUpdates");
    const chats = [...new Map(ups.map(u => (u.message || u.my_chat_member || {}).chat).filter(Boolean).map(c => [c.id, c])).values()];
    if (!chats.length) throw new Error("Сначала напишите боту /start в Telegram, потом запустите ещё раз.");
    for (const c of chats) await tg("sendMessage", { chat_id: c.id, text: `Номер этого чата: ${c.id}\nДобавьте его в GitHub как секрет TG_CHAT_ID.` });
    console.log("Отправил номер чата в Telegram.");
    return;
  }
  const { has, text } = build(await loadData());
  if (env.FIXTURE) { console.log(text); return; }
  if (!has && !ALWAYS) { console.log("Сегодня напоминать не о чем."); return; }
  await tg("sendMessage", { chat_id: env.TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true });
  console.log("Напоминание отправлено.");
}
main().catch(e => { console.error(e.message); process.exit(1); });
