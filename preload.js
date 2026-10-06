const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("viewcord", {
  updateRoom: (roomId) => ipcRenderer.invoke("update-room", roomId),
  clearRoom: () => ipcRenderer.invoke("clear-room"),
  getSources: () => ipcRenderer.invoke("get-sources"),
  onDeepLink: (callback) => {
    ipcRenderer.on("deep-link", (event, roomId) => callback(roomId));
  },
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),
});
