"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const ton_1 = require("@ton/ton");
const core_1 = require("@ton/core");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const prisma = new client_1.PrismaClient();
const rpcEndpoint = `${process.env.RPC_ENDPOINT}?api_key=${process.env.TONCENTER_API_KEY}`;
const client = new ton_1.TonClient({ endpoint: rpcEndpoint });
const contractAddr = ton_1.Address.parse(process.env.CONTRACT_ADDRESS);
// --- HTTP Server Setup ---
const app = (0, express_1.default)();
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
function getNormalizedExtMessageHash(message) {
    if (message.info.type !== 'external-in') {
        throw new Error(`Expected external-in, got ${message.info.type}`);
    }
    const info = { ...message.info, src: undefined, importFee: 0n };
    const normalized = { ...message, init: null, info };
    return (0, core_1.beginCell)()
        .store((0, core_1.storeMessage)(normalized, { forceRef: true }))
        .endCell()
        .hash();
}
// 2) Scan contract transactions for matching in-message hash
async function getTransactionByInMessage(inMessageBoc) {
    const slice = core_1.Cell.fromBase64(inMessageBoc).beginParse();
    const inMsg = (0, core_1.loadMessage)(slice);
    const targetHash = getNormalizedExtMessageHash(inMsg);
    let to_lt = undefined;
    while (true) {
        const txs = await client.getTransactions(contractAddr, {
            limit: 20,
            to_lt,
        });
        if (txs.length === 0)
            return undefined;
        for (const tx of txs) {
            if (!tx.inMessage)
                continue;
            const h = getNormalizedExtMessageHash(tx.inMessage);
            if (h.equals(targetHash))
                return tx;
        }
        to_lt = txs[txs.length - 1].lt.toString();
    }
}
// 3) Polling with retries + delay
async function waitForTransaction(inMessageBoc, retries = 20, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        const tx = await getTransactionByInMessage(inMessageBoc);
        if (tx)
            return tx;
        await new Promise(r => setTimeout(r, delayMs));
    }
    return undefined;
}
// 4) Single iteration: fetch pending, confirm, update DB
async function pollOnce() {
    const pendentes = await prisma.pendingPayment.findMany({
        where: { txHash: { not: null }, pago: false },
    });
    for (const p of pendentes) {
        const boc = p.txHash;
        console.log(`🔍 Checking PendingPayment#${p.id}…`);
        const tx = await waitForTransaction(boc);
        if (tx) {
            const realHash = tx.hash().toString('base64');
            console.log(`✓ #${p.id} confirmed (txHash=${realHash})`);
            await prisma.pendingPayment.update({
                where: { id: p.id },
                data: {
                    pago: true,
                    data_pagamento: new Date(),
                    txHash: realHash,
                },
            });
        }
        else {
            console.log(`⏳ #${p.id} not confirmed yet`);
            await prisma.pendingPayment.update({
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
        try {
            await pollOnce();
        }
        catch (e) {
            console.error('❌ Polling error:', e);
        }
        await new Promise(r => setTimeout(r, 60_000));
    }
}
main().catch(console.error);
