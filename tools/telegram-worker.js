// Сервер Telegram-бота Fairy Baby для Cloudflare Workers (бесплатно).
// Файл собран из tools/tg-remind.mjs командой node tools/make-worker.mjs. Не правьте вручную.
// Переменные (Settings → Variables and Secrets): TG_TOKEN, TG_CHAT_ID, FB_EMAIL, FB_PASSWORD, WEBHOOK_SECRET.
// ---core-start (общая часть, копируется в telegram-worker.js)
const API_KEY = "AIzaSyAbZ04WARp1d0OITEqbVCbs22a89KIQNdc";
const PROJECT = "fairy-baby";
const SITE = "https://lunat1k17.github.io/fairy-baby/";
let env = {};
const MODE = env.MODE || "daily";

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
  const S = ["📊 <b>Остатки на складе</b>"];
  const prods = D.products.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  let total = 0;
  for (const p of prods) { const q = stock(p.id); total += Math.max(q, 0); const lowMark = (p.minStock || 0) > 0 && q <= p.minStock ? " ⚠️" : ""; S.push(`• ${esc(p.name)}: <b>${fmt(q)}</b> пач.${lowMark}`); }
  if (!prods.length) S.push("Товаров пока нет.");
  else S.push(`Всего: <b>${fmt(total)}</b> пач.`);
  const head = `<b>Fairy Baby · ${fmtDate(t)}</b>`;
  const site = `<a href="${SITE}">Открыть сайт</a>`;
  const debtText = debts.length || low.length ? L.join("\n").trim() : "✅ Сегодня нет долгов к оплате и все размеры в наличии.";
  return {
    daily: [head, "", debtText, "", ...S, "", site].join("\n"),
    stock: [head, "", ...S].join("\n"),
    debts: [head, "", debtText].join("\n"),
  };
}


const HELP = "Команды:\n/ostatok — остатки на складе\n/dolgi — долги и что пора заказать\n/vse — всё вместе";
function pick(text) {
  const c = text.trim().toLowerCase().split(/[\s@]/)[0];
  if (["/ostatok", "/sklad", "остаток", "остатки", "склад"].includes(c)) return "stock";
  if (["/dolgi", "долги", "долг"].includes(c)) return "debts";
  if (["/vse", "/start", "всё", "все"].includes(c)) return "daily";
  return "help";
}
const send = (chat_id, text) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });

export default {
  async fetch(request, e) {
    env = e;
    const url = new URL(request.url);
    if (url.pathname === "/setup") {
      if (!e.WEBHOOK_SECRET || url.searchParams.get("key") !== e.WEBHOOK_SECRET) return new Response("Неверный ключ", { status: 403 });
      for (const k of ["TG_TOKEN", "TG_CHAT_ID", "FB_EMAIL", "FB_PASSWORD"]) if (!e[k]) return new Response("Не задана переменная " + k, { status: 400 });
      await tg("setWebhook", { url: url.origin + "/hook", secret_token: e.WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: true });
      await tg("setMyCommands", { commands: [{ command: "ostatok", description: "Остатки на складе" }, { command: "dolgi", description: "Долги и что пора заказать" }, { command: "vse", description: "Всё вместе" }] });
      await send(e.TG_CHAT_ID, "✅ Сервер подключён. Теперь бот отвечает на команды сразу.\n\n" + HELP);
      return new Response("Готово! Бот подключён, проверьте Telegram.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/hook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== e.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const u = await request.json().catch(() => ({}));
      const m = u.message;
      if (!m || !m.text || String(m.chat.id) !== String(e.TG_CHAT_ID)) return new Response("ok");
      const w = pick(m.text);
      try {
        if (w === "help") await send(m.chat.id, HELP);
        else await send(m.chat.id, build(await loadData())[w]);
      } catch (err) { await send(m.chat.id, "Не получилось: " + err.message).catch(() => {}); }
      return new Response("ok");
    }
    return new Response("Fairy Baby bot", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
