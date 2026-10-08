const { contextBridge, ipcRenderer } = require("electron");

const VALID_SEND_CHANNELS = [
  "window-minimize",
  "window-close",
  "renderer-ready",
];

contextBridge.exposeInMainWorld("viewcord", {
  updateRoom: (roomId) => ipcRenderer.invoke("update-room", roomId),
  clearRoom: () => ipcRenderer.invoke("clear-room"),
  getSources: () => ipcRenderer.invoke("get-sources"),
  ensureDiscord: () => ipcRenderer.invoke("ensure-discord"),
  onDeepLink: (callback) => {
    ipcRenderer.on("deep-link", (event, roomId) => callback(roomId));
  },
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),
  send: (channel, ...args) => {
    if (VALID_SEND_CHANNELS.includes(channel)) {
      ipcRenderer.send(channel, ...args);
    } else {
      console.warn(`Canal IPC não permitido: ${channel}`);
    }
  },
});
