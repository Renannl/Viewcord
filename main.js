const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  desktopCapturer,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const { ensureConnected, updatePresence, stopPresence } = require("./discord");

const APP_ICON = path.join(__dirname, "assets", "icon.png");
const TRAY_ICON = path.join(__dirname, "assets", "tray.png");
const START_HIDDEN = process.argv.includes("--hidden");

let mainWindow;
let pendingDeepLink = null;
let tray = null;
let isQuitting = false;
let rendererReady = false;

protocol.registerSchemesAsPrivileged([
  { scheme: "viewcord", privileges: { standard: true, secure: true } },
]);

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
    console.log(" Segunda instância detectada");
    console.log("commandLine:", commandLine);

    const url = extractDeepLink(commandLine);
    console.log("URL extraída:", url);

    if (!url) {
      console.log("❌ Nenhuma URL válida encontrada");
      return;
    }

    focusWindow();
    queueDeepLink(url);
  });
}

function extractDeepLink(args) {
  if (!args || !Array.isArray(args)) return null;
  console.log("Extraindo deep link de:", args);

  const raw = args.find((arg) => {
    if (typeof arg !== "string") return false;
    const clean = arg.trim().replace(/^["']|["']$/g, "");
    return clean.startsWith("viewcord://");
  });

  if (!raw) return null;

  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  console.log("Deep link encontrado:", cleaned);
  return cleaned;
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function queueDeepLink(url) {
  console.log("queueDeepLink chamado com:", url);
  pendingDeepLink = url;

  console.log(
    "rendererReady:",
    rendererReady,
    "mainWindow existe:",
    !!mainWindow,
  );

  if (rendererReady && mainWindow) {
    sendDeepLinkToRenderer();
  } else {
    console.log("Aguardando renderer ficar pronto...");
  }
}

function sendDeepLinkToRenderer() {
  console.log("sendDeepLinkToRenderer chamado. pending:", pendingDeepLink);
  if (!pendingDeepLink || !mainWindow) return;

  const match = pendingDeepLink.match(/room=([^&/?]+)/);
  if (!match) {
    console.log("Regex não encontrou room em:", pendingDeepLink);
    return;
  }

  const roomId = match[1];
  console.log("Enviando roomId:", roomId);
  focusWindow();
  mainWindow.webContents.send("deep-link", roomId);
  pendingDeepLink = null;
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON);

  tray = new Tray(icon);
  tray.setToolTip("ViewCord");

  const menu = Menu.buildFromTemplate([
    {
      label: "Abrir ViewCord",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "Sair",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  tray.on("click", () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    resizable: true,
    frame: false,
    show: false,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile("index.html");

  mainWindow.once("ready-to-show", () => {
    if (!START_HIDDEN) {
      mainWindow.show();
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
  });
}

app.whenReady().then(async () => {
  createWindow();
  createTray();

  app.setLoginItemSettings({
    openAtLogin: true,
    args: ["--hidden"],
  });

  const initialUrl = extractDeepLink(process.argv);
  if (initialUrl) {
    console.log("URL inicial encontrada:", initialUrl);
    queueDeepLink(initialUrl);
  } else {
    console.log("Nenhuma URL inicial encontrada em:", process.argv);
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  console.log("open-url (macOS):", url);
  focusWindow();
  queueDeepLink(url);
});

ipcMain.on("renderer-ready", () => {
  console.log("🟢 Renderer pronto.");
  rendererReady = true;
});

ipcMain.handle("get-pending-deep-link", () => {
  console.log("🔄 get-pending-deep-link chamado");
  console.log("pendingDeepLink:", pendingDeepLink);

  if (!pendingDeepLink) return null;

  const match = pendingDeepLink.match(/room=([^&/?]+)/);
  const roomId = match ? match[1] : null;

  console.log("Retornando roomId pendente:", roomId);
  pendingDeepLink = null;
  return roomId;
});

app.on("before-quit", () => {
  isQuitting = true;
  stopPresence();
});

ipcMain.handle("ensure-discord", async () => {
  try {
    await ensureConnected();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle("update-room", async (event, roomId) => {
  try {
    await ensureConnected();
  } catch (err) {
    return { ok: false, message: "Abra o Discord primeiro e tente novamente." };
  }

  updatePresence(roomId);
  return { ok: true };
});

ipcMain.handle("clear-room", () => {
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

app.on("window-all-closed", () => {});
