const seen = new Map(); // sig -> timestamp
function recentlySeen(sig) {
  const now = Date.now();
  const last = seen.get(sig);
  // cleanup occasionally
  if (seen.size > 5000) {
    for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  }
  if (last && now - last < 10 * 60 * 1000) return true; // 10 min
  seen.set(sig, now);
  return false;
}

function shortAddr(a = "") {
  return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

// rawTokenAmount = { tokenAmount: "<string>", decimals: <int> }
function rawToNumber(rawTokenAmount) {
  if (!rawTokenAmount) return 0;
  const { tokenAmount, decimals } = rawTokenAmount;
  // tokenAmount is base units (string). Convert safely-ish for typical swap sizes.
  const s = String(tokenAmount);
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  const d = Number(decimals || 0);

  // Insert decimal point
  const padded = digits.padStart(d + 1, "0");
  const intPart = padded.slice(0, padded.length - d);
  const fracPart = d ? padded.slice(padded.length - d) : "";
  const asStr = fracPart ? `${intPart}.${fracPart}` : intPart;
  const n = Number(asStr);
  return neg ? -n : n;
}

app.post("/webhook", async (req, res) => {
  try {
    // Verify Helius (recommended)
    const expected = process.env.HELIUS_AUTH;
    const auth = req.headers["authorization"];
    if (expected && auth !== expected) return res.status(401).send("Unauthorized");

    const mint = process.env.TOKEN_MINT;
    const minSol = Number(process.env.MIN_SOL || 0);

    const txs = Array.isArray(req.body) ? req.body : [req.body];
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);

    for (const tx of txs) {
      const sig = tx.signature || tx.transactionSignature;
      if (!sig || recentlySeen(sig)) continue;

      // Only handle SWAPs with parsed swap event
      if (tx.type !== "SWAP") continue;

      const swap = tx.events?.swap;
      if (!swap) continue;

      // BUY = your mint is in tokenOutputs (received), and NOT in tokenInputs
      const out = (swap.tokenOutputs || []).find(t => t.mint === mint);
      const inp = (swap.tokenInputs || []).find(t => t.mint === mint);
      if (!out || inp) continue; // buys only

      const tokensReceived = rawToNumber(out.rawTokenAmount);

      // SOL spent (lamports -> SOL) if present
      let solSpent = 0;
      if (swap.nativeInput?.amount) {
        solSpent = Number(swap.nativeInput.amount) / 1e9;
      }

      // Optional dust filter (only if SOL input exists)
      if (solSpent && solSpent < minSol) continue;

      const buyer = tx.feePayer || out.userAccount || "unknown";
      const source = tx.source ? String(tx.source) : "SWAP";

      const price = solSpent && tokensReceived ? (solSpent / tokensReceived) : null;

      const whale =
        solSpent >= 10 ? "🐋" :
        solSpent >= 2 ? "🦈" :
        solSpent >= 0.5 ? "🐬" : "🟢";

      let desc =
        `${whale} **BUY**\n` +
        `Received: **${tokensReceived.toLocaleString()}** tokens\n` +
        `Buyer: \`${shortAddr(buyer)}\`\n` +
        `Source: **${source}**\n`;

      if (solSpent) desc += `Spent: **${solSpent.toFixed(4)} SOL**\n`;
      if (price) desc += `Price: **${price.toExponential(6)} SOL/token**\n`;

      desc += `Tx: https://solscan.io/tx/${sig}`;

      await channel.send(desc);
    }

    res.send("ok");
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
});
