import express from 'express';
import { PrismaClient } from '@prisma/client';
import { TonClient, Address, Transaction } from '@ton/ton';
import {
  Cell,
  beginCell,
  loadMessage,
  storeMessage,
  Message
} from '@ton/core';

const prisma       = new PrismaClient();
const rpcEndpoint  = `${process.env.RPC_ENDPOINT}?api_key=${process.env.TONCENTER_API_KEY}`;
const client       = new TonClient({ endpoint: rpcEndpoint });
const contractAddr = Address.parse(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS!);

// --- HTTP Server Setup ---
const app = express();
// health check
app.get('/healthz', (_req, res) => res.status(200).send('OK'));
// keep-awake endpoint
app.get('/cronjobacorda', (_req, res) => res.status(200).send('awake'));

// start server
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`🚀 HTTP server listening on port ${port}`);
});

// 1) Normalize + TEP-467 hash of external-in message
function getNormalizedMessageHash(message: Message): Buffer {
  // Remove campos voláteis
  const info = { ...message.info, importFee: 0n };
  const normalized: Message = { ...message, init: null, info };
  return beginCell()
    .store(storeMessage(normalized, { forceRef: true }))
    .endCell()
    .hash();
}
// 2) Scan contract transactions for matching in-message hash
async function getTransactionByInMessage(
  inMessageBoc: string
): Promise<Transaction | undefined> {
  const slice      = Cell.fromBase64(inMessageBoc).beginParse();
  const inMsg      = loadMessage(slice);
  const targetHash = getNormalizedMessageHash(inMsg);

  let to_lt: string | undefined = undefined;

  while (true) {
    const txs: Transaction[] = await client.getTransactions(contractAddr, {
      limit: 20,
      to_lt,
    });
    if (txs.length === 0) return undefined;

    for (const tx of txs) {
      // apenas pula se não houver mensagem de entrada
      if (!tx.inMessage) continue;
      const h = getNormalizedMessageHash(tx.inMessage as Message);
      if (h.equals(targetHash)) {
        return tx;
      }
    }

    // próxima “página” descendo pelo lt
    to_lt = txs[txs.length - 1]!.lt.toString();
  }
}

// 3) Polling with retries + delay
async function waitForTransaction(
  inMessageBoc: string,
  retries = 20,
  delayMs = 2_000
): Promise<Transaction | undefined> {
  for (let i = 0; i < retries; i++) {
    const tx = await getTransactionByInMessage(inMessageBoc);
    if (tx) return tx;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return undefined;
}


// 4) Single iteration: fetch pending, confirm, update DB
async function pollOnce() {
  const pendentes = await prisma.pending_payments.findMany({
    where: { txHash: { not: null }, pago: false },
  });

  for (const p of pendentes) {
    const boc = p.txHash!;
    console.log(`🔍 Checking PendingPayment#${p.id}…`);

    const tx = await waitForTransaction(boc);
    if (tx) {
      const realHash = tx.hash().toString('base64');
      console.log(`✓ #${p.id} confirmed (txHash=${realHash})`);
      await prisma.pending_payments.update({
        where: { id: p.id },
        data: {
          pago: true,
          data_pagamento: new Date(),
          txHash: realHash,
        },
      });
    } else {
      console.log(`⏳ #${p.id} not confirmed yet`);
      await prisma.pending_payments.update({
        where: { id: p.id },
        data: { pollAttempts: p.pollAttempts + 1 },
      });
    }
  }
}

// 5) Main loop
async function main() {
  console.log('👷‍♂️ Polling service started');
  while (true) {
    try { await pollOnce(); }
    catch (e) { console.error('❌ Polling error:', e); }
    await new Promise(r => setTimeout(r, 60_000));
  }
}

main().catch(console.error);
