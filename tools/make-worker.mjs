// Собирает tools/telegram-worker.js (код для Cloudflare Worker) из общей части tg-remind.mjs.
// Запуск: node tools/make-worker.mjs
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(new URL("./tg-remind.mjs", import.meta.url), "utf8");
let core = src.slice(src.indexOf("// ---core-start"), src.indexOf("// ---core-end"));
core = core.replace("const env = process.env;", "let env = {};")
  .replace(/^\s*if \(env\.FIXTURE\).*\n/m, "");
const worker = `// Сервер Telegram-бота Fairy Baby для Cloudflare Workers (бесплатно).
// Файл собран из tools/tg-remind.mjs командой node tools/make-worker.mjs. Не правьте вручную.
// Переменные (Settings → Variables and Secrets): TG_TOKEN, TG_CHAT_ID, FB_EMAIL, FB_PASSWORD, WEBHOOK_SECRET.
${core}
const HELP = "Команды:\\n/ostatok — остатки на складе\\n/dolgi — долги и что пора заказать\\n/vse — всё вместе";
function pick(text) {
  const c = text.trim().toLowerCase().split(/[\\s@]/)[0];
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
      await send(e.TG_CHAT_ID, "✅ Сервер подключён. Теперь бот отвечает на команды сразу.\\n\\n" + HELP);
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
`;
writeFileSync(new URL("./telegram-worker.js", import.meta.url), worker);
console.log("telegram-worker.js собран");
