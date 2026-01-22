require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ===== ENV =====
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TOKEN_MINT = process.env.TOKEN_MINT; // 998mgH4...
const HELIUS_AUTH = process.env.HELIUS_AUTH; // optional
const MIN_SOL = Number(process.env.MIN_SOL || 0.01);

// Render sets PORT automatically
const PORT = process.env.PORT || 3000;

if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID");
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

// simple dedupe for retries
const seen = new Map();
function recentlySeen(sig) {
  const now = Date.now();
  const last = seen.get(sig);
  if (last && now - last < 10 * 60 * 1000) return true;
  seen.set(sig, now);
  if (seen.size > 5000) {
    for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  }
  return false;
}

// ===== EXPRESS (THIS WAS MISSING/TOO LOW IN YOUR FILE) =====
const app = express();
app.use((req, res, next) => {
  console.log("REQ", new Date().toISOString(), req.method, req.path);
  next();
});
app.get("/health", (req, res) => res.send("ok"));

app.post("/test", async (req, res) => {
  try {
    const channel = await getChannel();
    const embed = new EmbedBuilder()
      .setTitle("Test Buy Alert ✅")
      .setDescription("If you see this, Render → Discord posting works.")
      .setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== HELIUS ADVANCED WEBHOOK (BUY ONLY) =====
console.log("WEBHOOK HIT", new Date().toISOString());
  try {
    // If you set an auth header in Helius, it typically arrives as Authorization
    const auth = req.headers["authorization"];
    if (HELIUS_AUTH && auth !== HELIUS_AUTH) return res.status(401).send("Unauthorized");

    if (!TOKEN_MINT) return res.status(400).send("Missing TOKEN_MINT");

    const txs = Array.isArray(req.body) ? req.body : [req.body];
    const channel = await getChannel();

    for (const tx of txs) {
      const sig = tx.signature || tx.transactionSignature;
      if (!sig || recentlySeen(sig)) continue;

      // Helius Advanced usually sets type + events.swap for SWAPs
      if (tx.type !== "SWAP") continue;

      const swap = tx.events?.swap;
      if (!swap) continue;

      const out = (swap.tokenOutputs || []).find(t => t.mint === TOKEN_MINT);
      const inp = (swap.tokenInputs || []).find(t => t.mint === TOKEN_MINT);

      // BUY only: received your token (output), not spending it (input)
      if (!out || inp) continue;

      const tokensReceived = rawToNumber(out.rawTokenAmount);

      // SOL spent (nativeInput amount is lamports)
      let solSpent = 0;
      if (swap.nativeInput?.amount) solSpent = Number(swap.nativeInput.amount) / 1e9;

      if (solSpent && solSpent < MIN_SOL) continue;

      const buyer = tx.feePayer || out.userAccount || "unknown";
      const source = tx.source || "SWAP";
      const price = solSpent && tokensReceived ? solSpent / tokensReceived : null;

      const whale =
        solSpent >= 10 ? "🐋" :
        solSpent >= 2 ? "🦈" :
        solSpent >= 0.5 ? "🐬" : "🟢";

      const embed = new EmbedBuilder()
        .setTitle(`${whale} BUY`)
        .setDescription(
          `**Received:** ${tokensReceived.toLocaleString()} tokens\n` +
          (solSpent ? `**Spent:** ${solSpent.toFixed(4)} SOL\n` : "") +
          (price ? `**Price:** ${price.toExponential(6)} SOL/token\n` : "") +
          `**Buyer:** \`${shortAddr(buyer)}\`\n` +
          `**Source:** ${source}\n` +
          `**Tx:** https://solscan.io/tx/${sig}`
        )
        .setTimestamp(new Date());

      await channel.send({ embeds: [embed] });
    }

    res.send("ok");
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
});

// ===== START =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(DISCORD_BOT_TOKEN);

app.listen(PORT, () => console.log(`Listening on :${PORT}`));

