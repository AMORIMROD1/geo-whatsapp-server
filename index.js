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

const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const SUPABASE_FUNCTION_URL =
  process.env.SUPABASE_FUNCTION_URL;

let sock;
let currentQR = null;

let reconnectAttempts = 0;

const MAX_RECONNECTS = 5;

async function connectToWhatsApp() {
  try {
    console.log("INICIANDO WHATSAPP...");

    const { state, saveCreds } =
      await useMultiFileAuthState(
        "./auth_info"
      );

    const { version } =
      await fetchLatestBaileysVersion();

    console.log("VERSÃO:", version);

    sock = makeWASocket({
      auth: state,

      version,

      printQRInTerminal: false,

      logger: pino({
        level: "silent"
      }),

      browser: [
        "GeoGestao",
        "Chrome",
        "1.0.0"
      ],

      syncFullHistory: false,

      markOnlineOnConnect: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      generateHighQualityLinkPreview: false
    });

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        console.log(
          "UPDATE:",
          JSON.stringify(update)
        );

        if (qr) {
          console.log(
            "QR RECEBIDO"
          );

          currentQR =
            await QRCode.toDataURL(
              qr
            );

          console.log(
            "QR GERADO"
          );
        }

        if (
          connection === "open"
        ) {
          console.log(
            "WHATSAPP CONECTADO"
          );

          reconnectAttempts = 0;
        }

        if (
          connection === "close"
        ) {
          const statusCode =
            new Boom(
              lastDisconnect?.error
            ).output?.statusCode;

          console.log(
            "STATUS CODE:",
            statusCode
          );

          console.log(
            "CONEXÃO FECHADA"
          );

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          if (
            shouldReconnect &&
            reconnectAttempts <
              MAX_RECONNECTS
          ) {
            reconnectAttempts++;

            console.log(
              `RECONEXÃO ${reconnectAttempts}/${MAX_RECONNECTS}`
            );

            setTimeout(() => {
              connectToWhatsApp();
            }, 5000);
          } else {
            console.log(
              "LIMITE DE RECONEXÕES ATINGIDO"
            );
          }
        }
      }
    );

    sock.ev.on(
      "messages.upsert",
      async ({
        messages,
        type
      }) => {
        if (
          type !== "notify"
        )
          return;

        for (const msg of messages) {
          try {
            if (
              msg.key.fromMe
            )
              continue;

            if (
              !msg.message
            )
              continue;

            const from =
              msg.key.remoteJid;

            const text =
              msg.message
                ?.conversation ||
              msg.message
                ?.extendedTextMessage
                ?.text ||
              "";

            if (!text)
              continue;

            console.log(
              `MENSAGEM RECEBIDA: ${text}`
            );

            if (
              !SUPABASE_FUNCTION_URL
            ) {
              console.log(
                "SUPABASE_FUNCTION_URL não configurada"
              );

              continue;
            }

            const response =
              await fetch(
                SUPABASE_FUNCTION_URL,
                {
                  method: "POST",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  body: JSON.stringify({
                    data: {
                      key: {
                        remoteJid:
                          from
                      },

                      message: {
                        conversation:
                          text
                      }
                    }
                  })
                }
              );

            const result =
              await response.json();

            console.log(
              "RESPOSTA SUPABASE:",
              result
            );

            if (
              result?.reply
            ) {
              await sock.sendMessage(
                from,
                {
                  text: result.reply
                }
              );

              console.log(
                "RESPOSTA ENVIADA"
              );
            }
          } catch (err) {
            console.error(
              "ERRO AO PROCESSAR MENSAGEM:",
              err
            );
          }
        }
      }
    );
  } catch (err) {
    console.error(
      "ERRO AO CONECTAR:",
      err
    );
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
      <html>
        <body style="font-family:Arial;text-align:center;padding:40px;">
          <h2>QR ainda não gerado...</h2>

          <p>Aguarde alguns segundos.</p>

          <script>
            setTimeout(() => {
              location.reload()
            }, 3000)
          </script>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <body style="font-family:Arial;text-align:center;padding:40px;">
        <h1>Escaneie o QR Code</h1>

        <img src="${currentQR}" />

        <p>
          WhatsApp →
          Configurações →
          Aparelhos conectados →
          Conectar aparelho
        </p>
      </body>
    </html>
  `);
});

app.get("/reset", async (req, res) => {
  try {
    const authPath = path.join(
      __dirname,
      "auth_info"
    );

    if (
      fs.existsSync(authPath)
    ) {
      fs.rmSync(authPath, {
        recursive: true,
        force: true
      });
    }

    currentQR = null;

    res.send(
      "Sessão apagada. Reiniciando..."
    );

    console.log(
      "SESSÃO APAGADA"
    );

    setTimeout(() => {
      process.exit(0);
    }, 1000);

  } catch (err) {
    console.error(err);

    res.send(err.message);
  }
});

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `SERVIDOR ONLINE ${PORT}`
  );

  connectToWhatsApp();
});
