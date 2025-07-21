// src/index.ts

import 'dotenv/config';
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
const contractAddr = Address.parse(process.env.CONTRACT_ADDRESS!);

//
// 1) Normaliza e calcula o TEP-467 hash de uma mensagem external-in
//
function getNormalizedExtMessageHash(message: Message): Buffer {
  if (message.info.type !== 'external-in') {
    throw new Error(`Expected external-in, got ${message.info.type}`);
  }
  // Remove campos variáveis
  const info = { ...message.info, src: undefined, importFee: 0n };
  const normalized: Message = { ...message, init: null, info };
  return beginCell()
    .store(storeMessage(normalized, { forceRef: true }))
    .endCell()
    .hash();
}

//
// 2) Varre as transações do contrato em lotes até encontrar a que contém
//    o mesmo hash da in-message
//
async function getTransactionByInMessage(
  inMessageBoc: string
): Promise<Transaction | undefined> {
  // Desserializa a mensagem que salvamos (BOC base64)
  const slice = Cell.fromBase64(inMessageBoc).beginParse();
  const inMsg = loadMessage(slice);
  const targetHash = getNormalizedExtMessageHash(inMsg);

  // Vamos paginar pelos txs do contrato, do mais novo para o mais antigo
  let to_lt: string | undefined = undefined;

  while (true) {
    const txs: Transaction[] = await client.getTransactions(contractAddr, {
      limit: 20,
      to_lt,          // pega txs com lt < to_lt (descendente)
    });

    if (txs.length === 0) {
      return undefined;
    }

    for (const tx of txs) {
      if (!tx.inMessage) continue;
      // normaliza e compara o hash
      const h = getNormalizedExtMessageHash(tx.inMessage as Message);
      if (h.equals(targetHash)) {
        return tx;
      }
    }

    // prepara próxima página: usa o lt da última tx como to_lt
    const last = txs[txs.length - 1]!;
    to_lt = last.lt.toString();
  }
}

//
// 3) Função de polling com retries e delay
//
async function waitForTransaction(
  inMessageBoc: string,
  retries = 20,
  delayMs = 2_000
): Promise<Transaction | undefined> {
  for (let i = 0; i < retries; i++) {
    const tx = await getTransactionByInMessage(inMessageBoc);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return undefined;
}

//
// 4) Uma iteração: busca pendências, aguarda confirmação e atualiza o banco
//
async function pollOnce() {
  const pendentes = await prisma.pendingPayment.findMany({
    where: {
      txHash: { not: null },  // aqui guardamos o BOC da in-message
      pago:   false,
    },
  });

  for (const p of pendentes) {
    const inMessageBoc = p.txHash!;
    console.log(`🔍 Checando PendingPayment#${p.id}…`);

    const tx = await waitForTransaction(inMessageBoc);
    if (tx) {
      const confirmedHash = tx.hash().toString('base64');
      console.log(`✓ #${p.id} confirmado (txHash=${confirmedHash})`);

      await prisma.pendingPayment.update({
        where: { id: p.id },
        data: {
          pago:           true,
          data_pagamento: new Date(),
          txHash:         confirmedHash, // opcional: grava o hash real da tx
        },
      });
    } else {
      console.log(`⏳ #${p.id} não confirmado após tentativas`);
      await prisma.pendingPayment.update({
        where: { id: p.id },
        data: { pollAttempts: p.pollAttempts + 1 },
      });
    }
  }
}

//
// 5) Loop principal: executa pollOnce a cada minuto
//
async function main() {
  console.log('🚀 Polling service iniciado');
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('❌ Erro no polling:', err);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main().catch(console.error);
