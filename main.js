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

let mainWindow;

const APP_ICON = path.join(__dirname, "assets", "icon.png");
const TRAY_ICON = path.join(__dirname, "assets", "tray.png");
const START_HIDDEN = process.argv.includes("--hidden");

let tray = null;
let isQuitting = false;

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
    console.log("Segunda instância detectada");
    console.log("commandLine:", commandLine);

    const url = commandLine.find((arg) => arg.startsWith("viewcord://"));
    if (url && mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      handleDeepLink(url);
    }
  });
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
  });
}

app.whenReady().then(async () => {
  createWindow();
  createTray();

  app.setLoginItemSettings({
    openAtLogin: true,
    args: ["--hidden"],
  });

  const initialUrl = process.argv.find((arg) => arg.startsWith("viewcord://"));
  if (initialUrl) {
    console.log("URL inicial:", initialUrl);
    setTimeout(() => handleDeepLink(initialUrl), 1000);
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  console.log("open-url (macOS):", url);
  handleDeepLink(url);
});

app.on("before-quit", () => {
  isQuitting = true;
  stopPresence();
});

function handleDeepLink(url) {
  if (!url) return;
  console.log("Processando deep link:", url);

  const match = url.match(/room=([^&/?]+)/);
  if (match && mainWindow) {
    const roomId = match[1];
    console.log("Room ID extraído:", roomId);

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();

    mainWindow.webContents.send("deep-link", roomId);
  }
}

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

app.on("window-all-closed", () => {
  // App continua rodando na bandeja;
});
