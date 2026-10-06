const { Peer } = require('peerjs');

let peer = null;
let currentCall = null;
let currentStream = null;

async function initPeer() {
  return new Promise((resolve, reject) => {
    peer = new Peer({
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    peer.on('open', (id) => {
      console.log('🆔 Meu ID P2P:', id);
      resolve(id);
    });

    peer.on('error', (err) => {
      console.error('❌ Erro P2P:', err);
      reject(err);
    });

    peer.on('call', (call) => {
      call.answer();
      call.on('stream', (remoteStream) => {
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          // Electron não serializa MediaStream direto, então manda o ID
          win.webContents.send('remote-stream-ready', call.peer);
        }
      });
      currentCall = call;
    });
  });
}

async function startShare() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 60 },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: true
  });

  currentStream = stream;
  const roomId = peer.id;

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      currentCall = peer.call(conn.peer, stream);
    });
  });

  stream.getVideoTracks()[0].onended = () => {
    stopShare();
  };

  return roomId;
}

async function stopShare() {
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  return true;
}

async function joinRoom(roomId) {
  return new Promise((resolve, reject) => {
    const conn = peer.connect(roomId);
    conn.on('open', () => {
      resolve(true);
    });
    conn.on('error', reject);
  });
}

module.exports = { initPeer, startShare, stopShare, joinRoom };
