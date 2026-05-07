const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const express = require("express");
const fetch = require("node-fetch");
const pino = require("pino");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());

const SUPABASE_FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL;

let sock;
let currentQR = null;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 5;

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("QR RECEBIDO");

        currentQR = await QRCode.toDataURL(qr);

        console.log("QR GERADO");
      }

      if (connection === "open") {
        console.log("WHATSAPP CONECTADO");

        reconnectAttempts = 0;
      }

      if (connection === "close") {
        const shouldReconnect =
          new Boom(lastDisconnect?.error)?.output?.statusCode !==
          DisconnectReason.loggedOut;

        console.log("CONEXÃO FECHADA");

        if (shouldReconnect && reconnectAttempts < MAX_RECONNECTS) {
          reconnectAttempts++;

          console.log(
            `RECONEXÃO ${reconnectAttempts}/${MAX_RECONNECTS}`
          );

          setTimeout(() => {
            connectToWhatsApp();
          }, 5000);
        } else {
          console.log("LIMITE DE RECONEXÕES ATINGIDO");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        if (!msg.message) continue;

        const from = msg.key.remoteJid;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          "";

        if (!text) continue;

        console.log(`MENSAGEM: ${text}`);

        try {
          const response = await fetch(SUPABASE_FUNCTION_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              data: {
                key: {
                  remoteJid: from
                },
                message: {
                  conversation: text
                }
              }
            })
          });

          const result = await response.json();

          if (result?.reply) {
            await sock.sendMessage(from, {
              text: result.reply
            });
          }
        } catch (err) {
          console.error("ERRO SUPABASE:", err.message);
        }
      }
    });
  } catch (err) {
    console.error("ERRO GERAL:", err.message);
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    connected: !!sock,
    reconnectAttempts
  });
});

app.get("/qr", (req, res) => {
  if (!currentQR) {
    return res.send(`
      <h2>QR ainda não gerado...</h2>
      <script>
        setTimeout(() => location.reload(), 3000)
      </script>
    `);
  }

  res.send(`
    <html>
      <body style="font-family: Arial; text-align:center; padding:40px;">
        <h1>Escaneie o QR Code</h1>
        <img src="${currentQR}" />
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SERVIDOR ONLINE ${PORT}`);

  connectToWhatsApp();
});
