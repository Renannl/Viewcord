const DiscordRPC = require("discord-rpc");

const CLIENT_ID = "798971988722450442";

let rpc = null;
let connected = false;
let currentRoomId = null;

async function connect() {
  if (connected && rpc) return true;

  return new Promise((resolve, reject) => {
    rpc = new DiscordRPC.Client({ transport: "ipc" });

    rpc.once("ready", () => {
      connected = true;
      console.log("Discord RPC conectado");
      updatePresence(currentRoomId);
      resolve(true);
    });

    rpc.on("disconnected", () => {
      console.log("Discord RPC desconectado");
      connected = false;
      rpc = null;
    });

    rpc.login({ clientId: CLIENT_ID }).catch((err) => {
      console.log("Falha ao conectar Discord RPC:", err.message);
      connected = false;
      rpc = null;
      reject(new Error("Discord não está aberto ou não pôde ser conectado."));
    });
  });
}

async function ensureConnected() {
  if (connected && rpc) return true;
  await connect();
}

function updatePresence(roomId) {
  currentRoomId = roomId || null;

  if (!connected || !rpc) return;

  const activity = {
    details: roomId ? "Compartilhando tela" : "Aguardando",
    state: roomId ? "Clique no botão" : "Viewcord",
    largeImageKey: "viewcord_logo",
    largeImageText: "Viewcord",
    startTimestamp: Date.now(),
    instance: false,
  };

  if (roomId) {
    activity.buttons = [
      {
        label: "Assistir Tela",
        url: `https://viewcord-site.vercel.app/join?room=${roomId}`,
      },
    ];
  }

  rpc.setActivity(activity).catch((err) => {
    console.error("Erro ao setar presence:", err.message);
  });
}

function stopPresence() {
  if (rpc) {
    rpc.destroy().catch(() => {});
    rpc = null;
  }
  connected = false;
}

module.exports = { ensureConnected, updatePresence, stopPresence };
