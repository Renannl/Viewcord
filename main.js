const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  desktopCapturer,
} = require("electron");
const path = require("path");
const { initDiscordRPC, updatePresence, stopPresence } = require("./discord");

let mainWindow;
let currentRoomId = null;

protocol.registerSchemesAsPrivileged([
  { scheme: "viewcord", privileges: { standard: true, secure: true } },
]);

// No desenvolvimento, precisa informar a pasta do app
// No app empacotado, o executável já sabe onde está
if (app.isPackaged) {
  app.setAsDefaultProtocolClient("viewcord");
} else {
  app.setAsDefaultProtocolClient("viewcord", process.execPath, [__dirname]);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    console.log("🔄 Segunda instância detectada");
    console.log("📋 commandLine:", commandLine);

    const url = commandLine.find((arg) => arg.startsWith("viewcord://"));
    if (url && mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      handleDeepLink(url);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    frame: false,
    icon: path.join(__dirname, "assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createWindow();

  try {
    await initDiscordRPC();
    console.log("✅ Discord RPC inicializado");
  } catch (err) {
    console.log("⚠️ Discord RPC não conectado:", err.message);
  }

  setInterval(() => {
    console.log("♻️ Atualizando presence. Room atual:", currentRoomId);
    updatePresence(currentRoomId);
  }, 15000);

  // Captura deep link quando o app é aberto via protocolo no Windows
  const initialUrl = process.argv.find((arg) => arg.startsWith("viewcord://"));
  if (initialUrl) {
    console.log("🚀 URL inicial:", initialUrl);
    setTimeout(() => handleDeepLink(initialUrl), 1000);
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  console.log("🍎 open-url (macOS):", url);
  handleDeepLink(url);
});

function handleDeepLink(url) {
  if (!url) return;
  console.log("🔗 Processando deep link:", url);

  const match = url.match(/room=([^&/?]+)/);
  if (match && mainWindow) {
    const roomId = match[1];
    console.log("🆔 Room ID extraído:", roomId);
    mainWindow.webContents.send("deep-link", roomId);
  }
}

ipcMain.handle("update-room", (event, roomId) => {
  console.log("📝 Room atualizada:", roomId);
  currentRoomId = roomId;
  updatePresence(roomId);
  return true;
});

ipcMain.handle("clear-room", () => {
  currentRoomId = null;
  updatePresence(null);
  return true;
});

ipcMain.handle("get-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 320, height: 180 },
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: `data:image/png;base64,${source.thumbnail.toPNG().toString("base64")}`,
  }));
});

ipcMain.on("window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on("window-close", () => {
  if (mainWindow) mainWindow.close();
});

app.on("window-all-closed", () => {
  stopPresence();
  app.quit();
});
