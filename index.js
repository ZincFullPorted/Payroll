/**
 * index.js — Solana “buy bot” for Discord using Helius Advanced webhooks
 *
 * Endpoints:
 *  - GET  /health  -> "ok"
 *  - POST /test    -> posts a test embed to Discord
 *  - POST /webhook -> receives Helius Advanced tx payloads, posts BUY/SELL alerts
 *
 * Required env vars (Render -> Environment):
 *  - DISCORD_BOT_TOKEN
 *  - DISCORD_CHANNEL_ID
 *  - TOKEN_MINT
 *
 * Optional env vars:
 *  - HELIUS_AUTH   (string; if set, must match incoming Authorization header)
 *  - MIN_SOL       (default 0.01) ignore tiny swaps when SOL amount is known
 *  - POST_SELLS    ("true" to post sells too; default false -> only buys)
 */

require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ===== ENV =====
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TOKEN_MINT = process.env.TOKEN_MINT;
const HELIUS_AUTH = process.env.HELIUS_AUTH || "";
const MIN_SOL = Number(process.env.MIN_SOL || 0.01);
const POST_SELLS = String(process.env.POST_SELLS || "false").toLowerCase() === "true";

// Render sets PORT automatically; keep fallback for local.
const PORT = process.env.PORT || 3000;

if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID || !TOKEN_MINT) {
  console.error("Missing env vars. Required: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, TOKEN_MINT");
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
  if (!Number.isFinite(n)) return 0;
  return n / 1e9;
}

function rawToNumber(rawTokenAmount) {
  // rawTokenAmount: { tokenAmount: "123456", decimals: 6 }
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
  // Helius can include either tokenAmount or rawTokenAmount (or both)
  if (!t) return 0;
  if (typeof t.tokenAmount === "number") return t.tokenAmount;
  if (typeof t.tokenAmount === "string") return Number(t.tokenAmount);
  if (t.rawTokenAmount) return rawToNumber(t.rawTokenAmount);
  return 0;
}

// Dedupe: Helius may retry / send duplicates.
const seen = new Map(); // signature -> timestamp
function recentlySeen(sig) {
  const now = Date.now();
  const last = seen.get(sig);
  if (last && now - last < 10 * 60 * 1000) return true; // 10 min
  seen.set(sig, now);

  // cleanup
  if (seen.size > 5000) {
    for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  }
  return false;
}

// ===== EXPRESS =====
const app = express();
app.use(express.json({ limit: "2mb" }));

// Log every request (useful for debugging webhook delivery)
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

// ===== HELIUS ADVANCED WEBHOOK =====
app.post("/webhook", async (req, res) => {
  // Respond immediately so Helius doesn't retry due to slow processing
  res.status(200).send("ok");

  try {
    console.log("WEBHOOK HIT", new Date().toISOString());

    // Optional auth check: Helius sends configured auth header in Authorization
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
      if (!swap) continue; // ignore non-swap payloads

      // Net your mint across inputs/outputs
      const inAmt = (swap.tokenInputs || [])
        .filter((t) => t.mint === TOKEN_MINT)
        .reduce((s, t) => s + tokenAmt(t), 0);

      const outAmt = (swap.tokenOutputs || [])
        .filter((t) => t.mint === TOKEN_MINT)
        .reduce((s, t) => s + tokenAmt(t), 0);

      const net = outAmt - inAmt; // + = BUY, - = SELL
      if (net === 0) continue;

      const side = net > 0 ? "BUY" : "SELL";
      if (side === "SELL" && !POST_SELLS) continue;

      // SOL spent/received. For BUYs: usually nativeInput. For SELLs: usually nativeOutput.
      const solIn = lamportsToSol(swap.nativeInput?.amount);
      const solOut = lamportsToSol(swap.nativeOutput?.amount);
      const sol = side === "BUY" ? solIn : solOut;

      // Optional dust filter when SOL is known
      if (sol && sol < MIN_SOL) continue;

      const tokens = Math.abs(net);
      const buyer = tx.feePayer || tx.signer || "unknown";
      const source = tx.source || tx.type || "JUPITER";

      const whale =
        sol >= 10 ? "🐋" :
        sol >= 2 ? "🦈" :
        sol >= 0.5 ? "🐬" : (side === "BUY" ? "🟢" : "🔴");

      const price = sol && tokens ? sol / tokens : null;

      const embed = new EmbedBuilder()
        .setTitle(`${whale} ${side}`)
        .setDescription(
          `**Token:** \`${shortAddr(TOKEN_MINT)}\`\n` +
          `**Tokens:** ${Number(tokens).toLocaleString()}\n` +
          (sol ? `**SOL:** ${sol.toFixed(4)}\n` : "") +
          (price ? `**Price:** ${price.toExponential(6)} SOL/token\n` : "") +
          `**Wallet:** \`${shortAddr(buyer)}\`\n` +
          `**Source:** ${source}\n` +
          `**Tx:** https://solscan.io/tx/${sig}`
        )
        .setTimestamp(new Date());

      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error("Webhook handler error:", e);
  }
});

// ===== START =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(DISCORD_BOT_TOKEN);

app.listen(PORT, () => console.log(`Listening on :${PORT}`));
