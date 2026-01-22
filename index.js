require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ===== ENV =====
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TOKEN_MINT = process.env.TOKEN_MINT;

// OPTIONAL: leave empty while debugging
const HELIUS_AUTH = process.env.HELIUS_AUTH || "";

// Debug controls
const MIN_SOL = Number(process.env.MIN_SOL || 0);
const POST_SELLS = String(process.env.POST_SELLS || "true").toLowerCase() === "true";

const PORT = process.env.PORT || 3000;

if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID || !TOKEN_MINT) {
  console.error("Missing env vars: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, TOKEN_MINT");
  process.exit(1);
}

// ===== DISCORD =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function getChannel() {
  return await client.channels.fetch(DISCORD_CHANNEL_ID);
}

function shortAddr(a = "") {
  return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function lamportsToSol(lamports) {
  const n = Number(lamports || 0);
  return Number.isFinite(n) ? n / 1e9 : 0;
}

function rawToNumber(rawTokenAmount) {
  if (!rawTokenAmount) return 0;
  const s = String(rawTokenAmount.tokenAmount ?? "0");
  const d = Number(rawTokenAmount.decimals ?? 0);

  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;

  const padded = digits.padStart(d + 1, "0");
  const intPart = padded.slice(0, padded.length - d);
  const fracPart = d ? padded.slice(padded.length - d) : "";
  const asStr = fracPart ? `${intPart}.${fracPart}` : intPart;

  const n = Number(asStr);
  return neg ? -n : n;
}

function tokenAmt(t) {
  if (!t) return 0;
  if (typeof t.tokenAmount === "number") return t.tokenAmount;
  if (typeof t.tokenAmount === "string") return Number(t.tokenAmount);
  if (t.rawTokenAmount) return rawToNumber(t.rawTokenAmount);
  return 0;
}

// Dedupe retries
const seen = new Map();
function recentlySeen(sig) {
  const now = Date.now();
  const last = seen.get(sig);
  if (last && now - last < 10 * 60 * 1000) return true;
  seen.set(sig, now);
  return false;
}

// Log crashy stuff
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

// ===== EXPRESS =====
const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  console.log("REQ", new Date().toISOString(), req.method, req.path);
  next();
});

app.get("/health", (req, res) => res.send("ok"));

app.post("/test", async (req, res) => {
  try {
    const channel = await getChannel();
    const embed = new EmbedBuilder()
      .setTitle("Test Buy Bot ✅")
      .setDescription("If you see this, Render → Discord posting works.")
      .setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
    res.json({ ok: true });
  } catch (e) {
    console.error("Test error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  // reply fast so Helius doesn't retry/drop
  res.status(200).send("ok");

  console.log("WEBHOOK HIT", new Date().toISOString());

  try {
    // If you re-enable auth later:
    const auth = req.headers["authorization"] || "";
    if (HELIUS_AUTH && auth !== HELIUS_AUTH) {
      console.log("Unauthorized webhook: Authorization mismatch");
      return;
    }

    const txs = Array.isArray(req.body) ? req.body : [req.body];
    const channel = await getChannel();

    for (const tx of txs) {
      const sig = tx.signature || tx.transactionSignature;
      if (!sig || recentlySeen(sig)) continue;

      const swap = tx.events?.swap;
      if (!swap) {
        console.log("No swap event for tx", sig, "type:", tx.type);
        continue;
      }

      const ins = (swap.tokenInputs || []);
      const outs = (swap.tokenOutputs || []);

      // DEBUG: show mint lists so we know buy vs sell direction
      console.log("type:", tx.type, "source:", tx.source);
      console.log("inputs mints:", ins.map(t => t.mint));
      console.log("outputs mints:", outs.map(t => t.mint));

      // Net token across inputs/outputs
      const inAmt = ins.filter(t => t.mint === TOKEN_MINT).reduce((s, t) => s + tokenAmt(t), 0);
      const outAmt = outs.filter(t => t.mint === TOKEN_MINT).reduce((s, t) => s + tokenAmt(t), 0);
      const net = outAmt - inAmt;

      if (net === 0) {
        // This means your mint wasn't involved in this swap event
        continue;
      }

      const side = net > 0 ? "BUY" : "SELL";
      if (side === "SELL" && !POST_SELLS) continue;

      const solIn = lamportsToSol(swap.nativeInput?.amount);
      const solOut = lamportsToSol(swap.nativeOutput?.amount);
      const sol = side === "BUY" ? solIn : solOut;

      if (sol && sol < MIN_SOL) continue;

      const tokens = Math.abs(net);
      const wallet = tx.feePayer || tx.signer || "unknown";
      const source = tx.source || tx.type || "SWAP";

      const emoji = side === "BUY" ? "🟢" : "🔴";
      const price = sol && tokens ? sol / tokens : null;

      const embed = new EmbedBuilder()
        .setTitle(`${emoji} ${side}`)
        .setDescription(
          `**Token:** \`${shortAddr(TOKEN_MINT)}\`\n` +
          `**Tokens:** ${Number(tokens).toLocaleString()}\n` +
          (sol ? `**SOL:** ${sol.toFixed(4)}\`\n`.replace("`", "") : "") +
          (price ? `**Price:** ${price.toExponential(6)} SOL/token\n` : "") +
          `**Wallet:** \`${shortAddr(wallet)}\`\n` +
          `**Source:** ${source}\n` +
          `**Tx:** https://solscan.io/tx/${sig}`
        )
        .setTimestamp(new Date());

      try {
        await channel.send({ embeds: [embed] });
        console.log("Posted to Discord:", side, sig);
      } catch (e) {
        console.error("Discord send FAILED:", e);
      }
    }
  } catch (e) {
    console.error("Webhook handler error:", e);
  }
});

// ===== START =====
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

console.log("Attempting Discord login...");
client.login(DISCORD_BOT_TOKEN).catch((e) => {
  console.error("Discord login FAILED:", e);
  process.exit(1);
});

app.listen(PORT, () => console.log(`Listening on :${PORT}`));
