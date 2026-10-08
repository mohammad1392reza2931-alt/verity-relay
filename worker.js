// Verity relay for Minecraft Bedrock  (Cloudflare Worker)
// Minecraft connects here with:  /wsserver wss://YOUR-WORKER.workers.dev
// Then type in chat:  ai hello   (or: verity hello)
//
// Required secret (Settings > Variables and Secrets, type = Secret):
//   ZAI_API_KEY   your Z.ai API key
// Optional variables (type = Text):
//   MODEL         default: glm-4.7-flash
//   API_URL       default: https://api.z.ai/api/paas/v4/chat/completions

const TRIGGERS = ["ai ", "verity ", "وریتی "];

// Only these items can be given. Add more names here if you want.
const ALLOWED_ITEMS = new Set([
  "diamond", "emerald", "gold_ingot", "iron_ingot", "netherite_ingot", "coal", "copper_ingot",
  "stick", "oak_log", "oak_planks", "cobblestone", "stone", "dirt", "sand", "glass", "torch",
  "apple", "golden_apple", "bread", "cooked_beef", "cooked_porkchop", "cooked_chicken", "carrot", "potato",
  "wooden_sword", "stone_sword", "iron_sword", "diamond_sword", "netherite_sword",
  "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe",
  "iron_axe", "diamond_axe", "iron_shovel", "diamond_shovel", "bow", "arrow", "shield",
  "iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots",
  "diamond_helmet", "diamond_chestplate", "diamond_leggings", "diamond_boots",
  "ender_pearl", "water_bucket", "lava_bucket", "bucket", "crafting_table", "furnace", "chest",
  "bed", "white_bed", "oak_door", "ladder", "redstone", "slime_ball", "bone", "bone_meal", "wheat_seeds",
]);

const MAX_GIVE_PER_REPLY = 5;
const MAX_COUNT = 64;
const MAX_SAY_LENGTH = 300;
const COOLDOWN_MS = 3000;

const SYSTEM_PROMPT = `You are Verity, a friendly yellow smiley-face helper friend inside Minecraft Bedrock. You are playful, short and helpful.
Reply in the same language the player writes in (Persian if they write Persian).
Keep "say" under 250 characters, no markdown, no line breaks.
Answer ONLY with one JSON object and nothing else, in this shape:
{"say": "your reply", "give": [{"item": "diamond", "count": 5}]}
Use "give" only if the player clearly asks you to give them items. Otherwise use an empty list.
Item names are Minecraft ids without the "minecraft:" prefix, lowercase with underscores (for example: diamond, iron_sword, golden_apple).
Never give more than 64 of one item.`;

export default {
  async fetch(request, env) {
    const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
    if (upgrade !== "websocket") {
      console.log("non-websocket request, Upgrade header =", request.headers.get("Upgrade"));
      return new Response("Verity relay is running.", { status: 200 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const state = { history: new Map(), lastCall: new Map() };

    server.addEventListener("open", () => start(server));
    // On Workers the socket is already open after accept(), so start right away.
    start(server);

    console.log("ws accepted");
    server.addEventListener("close", (e) => console.log("ws close", e.code, e.reason));
    server.addEventListener("error", (e) => console.log("ws error", String(e.message || e)));

    server.addEventListener("message", (event) => {
      console.log("ws msg", String(event.data).slice(0, 200));
      handleMessage(server, event.data, env, state).catch((err) => {
        console.log("handler error", String(err));
      });
    });

    return new Response(null, { status: 101, webSocket: client });
  },
};

let started = new WeakSet();
function start(ws) {
  if (started.has(ws)) return;
  started.add(ws);
  ws.send(JSON.stringify({
    header: {
      version: 1,
      requestId: crypto.randomUUID(),
      messageType: "commandRequest",
      messagePurpose: "subscribe",
    },
    body: { eventName: "PlayerMessage" },
  }));
  runCommand(ws, tellrawCommand("@a", "§eVerity connected! Type: ai hello"));
}

async function handleMessage(ws, raw, env, state) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const header = msg.header || {};
  const body = msg.body || {};
  if (header.eventName !== "PlayerMessage") return;
  if (body.type !== "chat") return; // ignore our own tellraw / say messages

  const sender = String(body.sender || "");
  const text = String(body.message || "").trim();
  if (!sender || /["\\]/.test(sender)) return;

  const lower = text.toLowerCase();
  const trigger = TRIGGERS.find((t) => lower.startsWith(t));
  if (!trigger) return;
  const question = text.slice(trigger.length).trim();
  if (!question) return;

  const now = Date.now();
  if (now - (state.lastCall.get(sender) || 0) < COOLDOWN_MS) {
    runCommand(ws, tellrawCommand(selector(sender), "§7Wait a moment..."));
    return;
  }
  state.lastCall.set(sender, now);

  if (!env.ZAI_API_KEY) {
    runCommand(ws, tellrawCommand(selector(sender), "§cVerity: ZAI_API_KEY secret is missing in Cloudflare."));
    return;
  }

  const history = state.history.get(sender) || [];
  history.push({ role: "user", content: question });
  while (history.length > 8) history.shift();

  let reply;
  try {
    reply = await askZai(env, history);
  } catch (err) {
    runCommand(ws, tellrawCommand(selector(sender), "§cVerity: AI error. " + String(err.message || err).slice(0, 120)));
    return;
  }

  const parsed = parseReply(reply);
  history.push({ role: "assistant", content: parsed.say });
  state.history.set(sender, history);

  runCommand(ws, tellrawCommand(selector(sender), "§e<Verity>§r " + parsed.say));

  let given = 0;
  for (const g of parsed.give) {
    if (given >= MAX_GIVE_PER_REPLY) break;
    const item = String(g.item || "").replace(/^minecraft:/, "").toLowerCase();
    if (!/^[a-z_]+$/.test(item) || !ALLOWED_ITEMS.has(item)) {
      runCommand(ws, tellrawCommand(selector(sender), "§7(I can't give: " + item.slice(0, 30) + ")"));
      continue;
    }
    const count = Math.max(1, Math.min(MAX_COUNT, parseInt(g.count, 10) || 1));
    runCommand(ws, `give ${selector(sender)} minecraft:${item} ${count}`);
    given++;
  }
}

async function askZai(env, history) {
  const url = env.API_URL || "https://api.z.ai/api/paas/v4/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.ZAI_API_KEY,
    },
    body: JSON.stringify({
      model: env.MODEL || "glm-4.7-flash",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      temperature: 0.7,
      max_tokens: 400,
      stream: false,
      thinking: { type: "disabled" },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("HTTP " + res.status + " " + t.slice(0, 100));
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

function parseReply(text) {
  let say = "";
  let give = [];
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      say = String(obj.say || "");
      give = Array.isArray(obj.give) ? obj.give : [];
    } catch { /* fall through */ }
  }
  if (!say) say = cleaned;
  say = say.replace(/\s+/g, " ").trim().slice(0, MAX_SAY_LENGTH) || "...";
  return { say, give };
}

function selector(name) {
  return `@a[name="${name}"]`;
}

function tellrawCommand(target, text) {
  return `tellraw ${target} ${JSON.stringify({ rawtext: [{ text }] })}`;
}

function runCommand(ws, commandLine) {
  ws.send(JSON.stringify({
    header: {
      version: 1,
      requestId: crypto.randomUUID(),
      messageType: "commandRequest",
      messagePurpose: "commandRequest",
    },
    body: {
      version: 1,
      commandLine,
      origin: { type: "player" },
    },
  }));
}
