// worker/polling.js
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { TonClient, Address, Transaction } from '@ton/ton';
import { Cell, beginCell, loadMessage, storeMessage, Message } from '@ton/core';

const prisma       = new PrismaClient();
const rpcEndpoint  = `${process.env.RPC_ENDPOINT}?api_key=${process.env.TONCENTER_API_KEY}`;
const client       = new TonClient({ endpoint: rpcEndpoint });
const BOT_TOKEN   = process.env.BOT_TOKEN;
const API         = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- HTTP Server Setup ---
const app = express();
// health check
app.get('/healthz', (_req, res) => res.status(200).send('OK'));
// keep-awake endpoint
app.get('/cronjobacorda', (_req, res) => res.status(200).send('awake'));

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`🚀 HTTP server listening on port ${port}`);
});

// --- Utils: normalização de mensagem (TEP-467) ---
function getNormalizedMessageHash(message: any) {
  const info = { ...message.info };
  // remova sempre src
  if ('src' in info) delete info.src;
  // zere fees e campos mutáveis
  if ('importFee' in info)   info.importFee   = 0n;
  if ('bounce' in info)      info.bounce      = false;
  if ('bounced' in info)     info.bounced     = false;
  if ('ihrFee' in info)      info.ihrFee      = 0n;
  if ('forwardFee' in info)  info.forwardFee  = 0n;
  if ('createdLt' in info)   info.createdLt   = 0n;
  if ('createdAt' in info)   info.createdAt   = 0;

  const normalized = { ...message, init: null, info };
  return beginCell()
    .store(storeMessage(normalized, { forceRef: true }))
    .endCell()
    .hash();
}

// busca (paginada) nas txs da carteira do usuário
async function findTxInWallet(bocBase64: any, walletAddress: any) {
  const slice       = Cell.fromBase64(bocBase64).beginParse();
  const inMsg       = loadMessage(slice);
  const targetHash  = getNormalizedMessageHash(inMsg);
  const walletAddr  = Address.parse(walletAddress);

  let to_lt;
  for (let page = 0; page < 20; page++) {
    const txs = await client.getTransactions(walletAddr, {
      limit:    50,
      archival: true,
      to_lt,
    });
    if (txs.length === 0) break;

    for (const tx of txs) {
      if (!tx.inMessage) continue;
      const h = getNormalizedMessageHash(tx.inMessage);
      if (h.equals(targetHash)) {
        return tx;
      }
    }
    to_lt = txs[txs.length - 1].lt.toString();
  }
  return undefined;
}

// Iteração única de polling
async function pollOnce() {
  const pendentes = await prisma.pending_payments.findMany({
    where: { txHash: { not: null }, pago: false }
  });

  for (const p of pendentes) {
    console.log(`🔍 Checking #${p.id} attempts=${p.pollAttempts}`);
    const tx = await findTxInWallet(p.txHash, p.user_to_address);
    if (tx) {
      const realHash = tx.hash().toString('base64');
      console.log(`✓ #${p.id} confirmed`);
      // marca pago
      await prisma.pending_payments.update({
        where: { id: p.id },
        data: {
          pago:           true,
          data_pagamento: new Date(),
          txHash:         realHash
        }
      });
      // notificar no grupo
      const bag = await prisma.bags.findUnique({ where: { id: p.bag_id } });
      if (bag?.chat_id) {
        await fetch(`${API}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({
            chat_id: bag.chat_id.toString(),
            text: `✅ Pagamento #${p.id} confirmado on-chain!`
          })
        });
      }
    } else {
      // se já bateu 10 tentativas, faz reset
      if (p.pollAttempts + 1 >= 10) {
        console.log(`⚠️ #${p.id} falhou após 10 tentativas, resetando`);
        // limpa para novo pagamento
        await prisma.pending_payments.update({
          where: { id: p.id },
          data: {
            pollAttempts:      0,
            txHash:            null,
            user_to_address:   null
          }
        });
        // notifica no grupo
        const bag = await prisma.bags.findUnique({ where: { id: p.bag_id } });
        if (bag?.chat_id) {
          await fetch(`${API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({
              chat_id: bag.chat_id.toString(),
              text: `❌ Pagamento #${p.id} não foi confirmado depois de 10 tentativas. Por favor, tente pagar de novo mais tarde.`
            })
          });
        }
      } else {
        // incrementa tentativas
        await prisma.pending_payments.update({
          where: { id: p.id },
          data: { pollAttempts: p.pollAttempts + 1 }
        });
        console.log(`⏳ #${p.id} ainda não confirmado (attempts=${p.pollAttempts + 1})`);
      }
    }
  }
}

// Loop principal
async function main() {
  console.log('👷‍♂️ Polling service started');
  while (true) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('❌ Polling error:', e);
    }
    // espera 60s antes da próxima rodada
    await new Promise(r => setTimeout(r, 60_000));
  }
}

main().catch(console.error);
