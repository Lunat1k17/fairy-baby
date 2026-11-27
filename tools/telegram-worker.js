// Сервер Telegram-бота Fairy Baby для Cloudflare Workers (бесплатно).
// Файл собран из tools/tg-remind.mjs командой node tools/make-worker.mjs. Не правьте вручную.
// Переменные (Settings → Variables and Secrets): TG_TOKEN, TG_CHAT_ID, FB_EMAIL, FB_PASSWORD, WEBHOOK_SECRET.
// Утреннее сообщение: Settings → Trigger Events → Cron Triggers → 0 4 * * *
// ---core-start (общая часть, копируется в telegram-worker.js)
const API_KEY = "AIzaSyAbZ04WARp1d0OITEqbVCbs22a89KIQNdc";
const PROJECT = "fairy-baby";
const SITE = "https://lunat1k17.github.io/fairy-baby/";
let env = {};

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

let idToken = "";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/`;
async function fsFetch(path, opt = {}) {
  const h = { "content-type": "application/json", referer: SITE };
  if (!idToken) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, { method: "POST", headers: h, body: JSON.stringify({ email: env.FB_EMAIL, password: env.FB_PASSWORD, returnSecureToken: true }) });
    const auth = await r.json(); if (!auth.idToken) throw new Error("Не удалось войти в Firebase: " + (auth.error && auth.error.message));
    idToken = auth.idToken;
  }
  const r = await fetch(FS + path, { ...opt, headers: { ...h, authorization: "Bearer " + idToken } });
  if (r.status === 404) return null;
  const j = await r.json(); if (j.error) throw new Error("Firestore: " + j.error.message); return j;
}
async function loadData() {
  const out = {};
  for (const name of ["products", "parties", "ops"]) {
    out[name] = []; let page = "";
    do {
      const j = await fsFetch(`${name}?pageSize=300` + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
      for (const d of (j && j.documents) || []) out[name].push({ id: d.name.split("/").pop(), ...obj(d.fields || {}) });
      page = (j && j.nextPageToken) || "";
    } while (page);
  }
  return out;
}

// ---- Кому можно пользоваться ботом ----
const owners = () => String(env.TG_CHAT_ID || "").split(/[\s,;]+/).filter(Boolean);
async function partners() {
  const d = await fsFetch("settings/telegram");
  return (d && d.fields ? obj(d.fields).chats : null) || [];
}
async function savePartners(list) {
  const enc = list.map(c => ({ mapValue: { fields: { id: { stringValue: String(c.id) }, name: { stringValue: c.name || "" } } } }));
  await fsFetch("settings/telegram?updateMask.fieldPaths=chats", { method: "PATCH", body: JSON.stringify({ fields: { chats: { arrayValue: enc.length ? { values: enc } : {} } } }) });
}
async function allChats() { return [...new Set([...owners(), ...(await partners()).map(c => String(c.id))])]; }

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

const COMMANDS = [{ command: "ostatok", description: "Остатки на складе" }, { command: "dolgi", description: "Долги и что пора заказать" }, { command: "vse", description: "Всё вместе" }];
const HELP = "Команды:\n/ostatok — остатки на складе\n/dolgi — долги и что пора заказать\n/vse — всё вместе";
const OWNER_HELP = "\n\nДля владельца:\n/dobavit номер — дать доступ партнёру\n/ubrat номер — забрать доступ\n/spisok — кто имеет доступ";
const sendTo = (chat_id, text) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });
const who = m => [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(" ") + (m.from && m.from.username ? " @" + m.from.username : "");

// Ответ на одно сообщение. cache хранит данные, чтобы не читать их по нескольку раз.
async function handle(m, cache = {}) {
  if (!m || !m.text || !m.chat) return;
  const id = String(m.chat.id), text = m.text.trim(), parts = text.split(/\s+/), c = parts[0].toLowerCase().split("@")[0];
  const isOwner = owners().includes(id);
  cache.partners = cache.partners || await partners();
  const isPartner = cache.partners.some(p => String(p.id) === id);
  if (!isOwner && !isPartner) {
    await sendTo(id, `Здравствуйте! Этот бот закрытый.\nВаш номер: <code>${id}</code>\n` + (c === "/start" ? "Владелец получил запрос и может дать вам доступ." : "Нажмите /start, чтобы отправить запрос владельцу."));
    if (c === "/start") for (const o of owners()) await sendTo(o, `🔑 Просит доступ к боту: <b>${esc(who(m) || "без имени")}</b>\nЧтобы разрешить, отправьте:\n<code>/dobavit ${id}</code>`);
    return;
  }
  if (isOwner && (c === "/dobavit" || c === "/ubrat")) {
    const target = (parts[1] || "").replace(/[^-\d]/g, "");
    if (!target) { await sendTo(id, `Напишите номер, например: <code>${c} 123456789</code>`); return; }
    let list = cache.partners.filter(p => String(p.id) !== target);
    if (c === "/dobavit") {
      const name = parts.slice(2).join(" ");
      list.push({ id: target, name });
      await savePartners(list); cache.partners = list;
      await sendTo(id, `✅ Доступ выдан: ${target}${name ? " (" + esc(name) + ")" : ""}. Он будет получать утренние напоминания и сможет смотреть остатки и долги.`);
      await sendTo(target, "✅ Вам открыли доступ к боту Fairy Baby.\n\n" + HELP).catch(() => {});
    } else {
      await savePartners(list); cache.partners = list;
      await sendTo(id, `Доступ убран: ${target}.`);
    }
    return;
  }
  if (isOwner && c === "/spisok") {
    await sendTo(id, cache.partners.length ? "Партнёры с доступом:\n" + cache.partners.map(p => `• <code>${p.id}</code>${p.name ? " " + esc(p.name) : ""}`).join("\n") : "Партнёров пока нет. Пусть партнёр напишет боту /start, и вам придёт запрос.");
    return;
  }
  const w = ["/ostatok", "/sklad", "остаток", "остатки", "склад"].includes(c) ? "stock" : ["/dolgi", "долги", "долг"].includes(c) ? "debts" : ["/vse", "всё", "все"].includes(c) ? "daily" : "help";
  if (w === "help") { await sendTo(id, (c === "/start" ? "Здравствуйте! " : "") + HELP + (isOwner ? OWNER_HELP : "")); return; }
  cache.report = cache.report || build(await loadData());
  await sendTo(id, cache.report[w]);
}


export default {
  async fetch(request, e) {
    env = e; idToken = "";
    const url = new URL(request.url);
    if (url.pathname === "/setup") {
      if (!e.WEBHOOK_SECRET || url.searchParams.get("key") !== e.WEBHOOK_SECRET) return new Response("Неверный ключ", { status: 403 });
      for (const k of ["TG_TOKEN", "TG_CHAT_ID", "FB_EMAIL", "FB_PASSWORD"]) if (!e[k]) return new Response("Не задана переменная " + k, { status: 400 });
      await tg("setWebhook", { url: url.origin + "/hook", secret_token: e.WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: true });
      await tg("setMyCommands", { commands: COMMANDS });
      for (const o of owners()) await sendTo(o, "✅ Сервер подключён. Теперь бот отвечает на команды сразу.\n\n" + HELP + OWNER_HELP);
      return new Response("Готово! Бот подключён, проверьте Telegram.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/hook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== e.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const u = await request.json().catch(() => ({}));
      try { await handle(u.message); } catch (err) { if (u.message && u.message.chat) await sendTo(u.message.chat.id, "Не получилось: " + esc(err.message)).catch(() => {}); }
      return new Response("ok");
    }
    return new Response("Fairy Baby bot", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
  // Утреннее сообщение. В Cloudflare: Settings → Trigger Events → Cron: 0 4 * * * (9:00 по Ташкенту).
  async scheduled(event, e, ctx) {
    env = e; idToken = "";
    const r = build(await loadData());
    for (const c of await allChats()) await sendTo(c, r.daily).catch(() => {});
  },
};
