const DiscordRPC = require("discord-rpc");

const CLIENT_ID = "798971988722450442";

const rpc = new DiscordRPC.Client({ transport: "ipc" });
let connected = false;

async function initDiscordRPC() {
  rpc.on("ready", () => {
    connected = true;
    console.log("✅ Conectado ao Discord RPC");
    updatePresence(null);
  });

  await rpc.login({ clientId: CLIENT_ID });
}

function updatePresence(roomId) {
  if (!connected) return;

  const activity = {
    details: roomId ? "Compartilhando tela" : "Aguardando",
    state: roomId ? "Clique no botão 👇" : "ViewCord",
    largeImageKey: "viewcord_logo",
    largeImageText: "ViewCord",
    startTimestamp: Date.now(),
    instance: false,
  };

  if (roomId) {
    activity.buttons = [
      {
        label: "📺 Assistir Tela",
        url: `https://viewcord-site.vercel.app/join?room=${roomId}`,
      },
    ];
  }

  rpc.setActivity(activity).catch(console.error);
}

function stopPresence() {
  if (connected) {
    rpc.destroy().catch(() => {});
  }
}

module.exports = { initDiscordRPC, updatePresence, stopPresence };
