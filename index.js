const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fetch = require('node-fetch');
const pino = require('pino');

const app = express();
app.use(express.json());

const SUPABASE_FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL;
// Ex: https://rmqasagyxxzfxerixpbc.supabase.co/functions/v1/whatsapp-agent

let sock;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: true, // QR Code aparece nos logs do Railway
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code gerado — escaneie pelo WhatsApp (Settings > Linked Devices)');
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão encerrada. Reconectando?', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // Ignora mensagens enviadas pelo próprio bot
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text) continue;

      console.log(`📩 Mensagem de ${from}: ${text}`);

      try {
        // Repassa para a Edge Function do Supabase
        const response = await fetch(SUPABASE_FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: {
              key: { remoteJid: from },
              message: { conversation: text },
            },
          }),
        });

        const result = await response.json();
        const reply = result?.reply;

        if (reply) {
          await sock.sendMessage(from, { text: reply });
          console.log(`✉️  Resposta enviada para ${from}`);
        }
      } catch (err) {
        console.error('Erro ao chamar Supabase:', err.message);
      }
    }
  });
}

// Rota de health check (Railway usa isso para saber se o servidor está vivo)
app.get('/', (req, res) => res.json({ status: 'GeoGestão WhatsApp Server online ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  connectToWhatsApp();
});
