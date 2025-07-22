// worker/polling.js
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { TonClient, Address, Transaction } from '@ton/ton';
import { Cell, beginCell, loadMessage, storeMessage, Message } from '@ton/core';

const prisma       = new PrismaClient();
const rpcEndpoint  = `${process.env.RPC_ENDPOINT}?api_key=${process.env.TONCENTER_API_KEY}`;
const client       = new TonClient({ endpoint: rpcEndpoint });

// --- Utils: normalização de mensagem (TEP-467) ---
function getNormalizedMessageHash(message: any) {
  const info = { ...message.info };
  // remova sempre src
  if ('src' in info) delete info.src;
  // zere fees
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
    .hash();  // retorna Buffer
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
    where: { txHash: { not: null }, pago: false },
  });

  for (const p of pendentes) {
    console.log(`🔍 Checking PendingPayment#${p.id} (wallet=${p.user_to_address})…`);
    const tx = await findTxInWallet(p.txHash, p.user_to_address);
    if (tx) {
      const realHash = tx.hash().toString('base64');
      console.log(`✓ #${p.id} confirmed (txHash=${realHash})`);
      await prisma.pending_payments.update({
        where: { id: p.id },
        data: {
          pago:          true,
          data_pagamento: new Date(),
          txHash:        realHash,  // substitui BOC pelo hash real da tx
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
