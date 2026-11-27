// Собирает tools/telegram-worker.js (код для Cloudflare Worker) из общей части tg-remind.mjs.
// Запуск: node tools/make-worker.mjs
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(new URL("./tg-remind.mjs", import.meta.url), "utf8");
let core = src.slice(src.indexOf("// ---core-start"), src.indexOf("// ---core-end"));
core = core.replace("const env = process.env;", "let env = {};").replace(/^const MODE.*\n/m, "")
  .replace(/^\s*if \(env\.FIXTURE\).*\n/m, "").replace(/^\s*if \(env\.FIXTURE_PARTNERS.*\n/gm, "");
const worker = `// Сервер Telegram-бота Fairy Baby для Cloudflare Workers (бесплатно).
// Файл собран из tools/tg-remind.mjs командой node tools/make-worker.mjs. Не правьте вручную.
// Переменные (Settings → Variables and Secrets): TG_TOKEN, TG_CHAT_ID, FB_EMAIL, FB_PASSWORD, WEBHOOK_SECRET.
${core}
export default {
  async fetch(request, e) {
    env = e; idToken = "";
    const url = new URL(request.url);
    if (url.pathname === "/setup") {
      if (!e.WEBHOOK_SECRET || url.searchParams.get("key") !== e.WEBHOOK_SECRET) return new Response("Неверный ключ", { status: 403 });
      for (const k of ["TG_TOKEN", "TG_CHAT_ID", "FB_EMAIL", "FB_PASSWORD"]) if (!e[k]) return new Response("Не задана переменная " + k, { status: 400 });
      await tg("setWebhook", { url: url.origin + "/hook", secret_token: e.WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: true });
      await tg("setMyCommands", { commands: COMMANDS });
      for (const o of owners()) await sendTo(o, "✅ Сервер подключён. Теперь бот отвечает на команды сразу.\\n\\n" + HELP + OWNER_HELP);
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
};
`;
writeFileSync(new URL("./telegram-worker.js", import.meta.url), worker);
console.log("telegram-worker.js собран");
