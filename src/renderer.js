const screens = {
  idle: document.getElementById("screen-idle"),
  sharing: document.getElementById("screen-sharing"),
  watching: document.getElementById("screen-watching"),
};

const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btn-start");
const qualitySelect = document.getElementById("quality-select");
const audioProcessSelect = document.getElementById("audio-process-select");
const btnRefreshProcesses = document.getElementById("btn-refresh-processes");

let peer = null;
let currentCall = null;
let currentStream = null;
let peerReady = false;
let pendingDeepLinkRoom = null;
let peerConnecting = false;
let globalCallListenerSet = false;
let deepLinkProcessed = false;
let lastProcessedRoom = null;

const activeCalls = new Map();
const connectedViewers = new Set();

const tauri = window.__TAURI__?.core;
const tauriEvent = window.__TAURI__?.event;

let nativeAudio = null;

const toastIcons = {
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="#3ba55d" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="#ed4245" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="#faa61a" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="#00aff4" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toast-container");

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${toastIcons[type] || toastIcons.info}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-out-animation");
    toast.addEventListener("animationend", () => toast.remove());
  }, duration);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function updateViewerCount() {
  const count = connectedViewers.size;
  const el = document.getElementById("viewers-count");
  if (el) {
    el.textContent = `${count} ${count === 1 ? "espectador" : "espectadores"}`;
  }
  const liveStatus = document.getElementById("live-status");
  if (liveStatus) {
    liveStatus.style.display = currentStream ? "flex" : "none";
  }
}

function destroyPeer() {
  if (!peer) return;
  try {
    peer.destroy();
  } catch (err) {
    console.warn("Erro ao destruir peer:", err);
  }
  peer = null;
  peerReady = false;
  peerConnecting = false;
  globalCallListenerSet = false;
  setStatus("⚪ Ocioso — clique em Compartilhar ou Assistir para conectar");
}

function setupGlobalCallListener() {
  if (globalCallListenerSet) return;
  globalCallListenerSet = true;

  peer.on("call", (call) => {
    answerCall(call);
  });
}

function initPeer() {
  if (peerConnecting) {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (peerReady) {
          clearInterval(check);
          resolve(peer.id);
        }
        if (!peerConnecting && !peerReady) {
          clearInterval(check);
          reject(new Error("Conexão P2P cancelada"));
        }
      }, 100);
    });
  }

  peerConnecting = true;
  setStatus("🟡 Conectando P2P...");

  return new Promise((resolve, reject) => {
    peer = new Peer({
      debug: 1,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      },
    });

    peer.on("connection", (conn) => {
      conn.on("open", () => {});

      conn.on("data", (data) => {
        if (data === "viewer-ready" && currentStream) {
          const videoTrack = currentStream.getVideoTracks()[0];
          if (!videoTrack || videoTrack.readyState !== "live") {
            return;
          }

          if (!connectedViewers.has(conn.peer)) {
            connectedViewers.add(conn.peer);
            updateViewerCount();
          }

          if (activeCalls.has(conn.peer)) return;

          const call = peer.call(conn.peer, currentStream);

          call.on("error", (err) => {
            showToast("Erro na transmissão. Encerrando...", "error");
            stopShare();
          });

          call.on("close", () => {
            activeCalls.delete(conn.peer);
            connectedViewers.delete(conn.peer);
            updateViewerCount();
          });

          activeCalls.set(conn.peer, call);
        }
      });

      conn.on("close", () => {
        if (activeCalls.has(conn.peer)) {
          activeCalls.get(conn.peer).close();
          activeCalls.delete(conn.peer);
        }
        connectedViewers.delete(conn.peer);
        updateViewerCount();
      });

      conn.on("error", () => {});
    });

    peer.on("open", (id) => {
      peerReady = true;
      peerConnecting = false;
      btnStart.disabled = false;
      setStatus("🟢 Conectado P2P — pronto pra compartilhar");

      setupGlobalCallListener();

      if (pendingDeepLinkRoom) {
        const roomId = pendingDeepLinkRoom;
        pendingDeepLinkRoom = null;
        handleDeepLinkRoom(roomId);
      }

      resolve(id);
    });

    peer.on("error", (err) => {
      peerConnecting = false;
      setStatus("❌ Erro P2P: " + err.message);

      if (err.type === "network" || err.type === "server-error") {
        showToast("Conexão perdida. Tentando reconectar...", "warning");
      } else if (err.type === "peer-unavailable") {
        showToast("Sala não encontrada ou offline.", "error");
      }

      reject(err);
    });
  });
}

async function ensurePeer() {
  if (peerReady && peer) return peer.id;
  return initPeer();
}

function getVideoConstraints() {
  const quality = qualitySelect.value;

  if (quality === "fhd") {
    return {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    };
  }

  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
}

function toUint8Array(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (Array.isArray(payload)) return new Uint8Array(payload);
  if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    return new Uint8Array(payload.data);
  }
  return null;
}

function bytesToFloat32(bytes) {
  if (!bytes || bytes.length === 0) return new Float32Array(0);
  const int16 = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 2,
  );
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    out[i] = int16[i] / 32768.0;
  }
  return out;
}

async function startNativeAudio(pid) {
  if (!tauri || !tauriEvent) {
    throw new Error("Backend Tauri não disponível");
  }
  if (nativeAudio) {
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx({ sampleRate: 48000 });

  const destination = context.createMediaStreamDestination();
  const processor = context.createScriptProcessor(4096, 2, 2);

  const state = {
    context,
    destination,
    processor,
    track: destination.stream.getAudioTracks()[0],
    pcmBuffer: new Float32Array(48000 * 2 * 2),
    pcmLength: 0,
    unlisten: null,
  };

  processor.onaudioprocess = (e) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const frames = outL.length;
    const samplesNeeded = frames * 2;

    if (state.pcmLength >= samplesNeeded) {
      for (let i = 0; i < frames; i++) {
        outL[i] = state.pcmBuffer[i * 2];
        outR[i] = state.pcmBuffer[i * 2 + 1];
      }
      state.pcmBuffer.copyWithin(0, samplesNeeded, state.pcmLength);
      state.pcmLength -= samplesNeeded;
    } else {
      outL.fill(0);
      outR.fill(0);
    }
  };

  processor.connect(destination);

  const silence = context.createGain();
  silence.gain.value = 0;
  processor.connect(silence);
  silence.connect(context.destination);

  const unlisten = await tauriEvent.listen("audio-chunk", (event) => {
    const bytes = toUint8Array(event.payload);
    if (!bytes || bytes.length === 0) return;

    const float32 = bytesToFloat32(bytes);

    if (state.pcmLength + float32.length > state.pcmBuffer.length) {
      const newBuf = new Float32Array(
        Math.max(state.pcmBuffer.length * 2, state.pcmLength + float32.length),
      );
      newBuf.set(state.pcmBuffer.subarray(0, state.pcmLength));
      state.pcmBuffer = newBuf;
    }

    state.pcmBuffer.set(float32, state.pcmLength);
    state.pcmLength += float32.length;
  });

  state.unlisten = unlisten;
  nativeAudio = state;

  await context.resume().catch(() => {});
  await tauri.invoke("start_audio_capture", { pid });
}

async function stopNativeAudio() {
  if (!nativeAudio) return;
  const state = nativeAudio;
  nativeAudio = null;

  try {
    await tauri.invoke("stop_audio_capture");
  } catch (err) {
    console.error("Erro ao parar captura nativa:", err);
  }

  if (state.unlisten) {
    state.unlisten();
    state.unlisten = null;
  }

  if (state.track) {
    state.track.stop();
  }

  try {
    state.processor.disconnect();
  } catch (_) {}

  try {
    state.context.close();
  } catch (_) {}
}

async function loadAudioProcesses() {
  if (!tauri) return;
  try {
    const processes = await tauri.invoke("list_audio_processes");
    const currentValue = audioProcessSelect.value;

    audioProcessSelect.innerHTML = '<option value="">Sem áudio</option>';

    processes.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = String(p.pid);
      opt.textContent = p.name;
      audioProcessSelect.appendChild(opt);
    });

    const hasCurrent = [...audioProcessSelect.options].some(
      (o) => o.value === currentValue,
    );
    if (hasCurrent) {
      audioProcessSelect.value = currentValue;
    }
  } catch (err) {
    showToast(`Erro ao listar processos: ${err}`, "error", 5000);
  } finally {
    btnRefreshProcesses.disabled = false;
    btnRefreshProcesses.textContent = "↻";
  }
}

async function ensureLoopbackSupport() {
  const supported = await tauri.invoke("check_process_loopback_support");

  const warning = document.getElementById("audio-fallback-warning");
  if (!supported && warning) {
    warning.style.display = "block";
  } else if (warning) {
    warning.style.display = "none";
  }
  return supported;
}

async function startShare() {
  await ensureLoopbackSupport();
  if (!peerReady || !peer.id) {
    throw new Error("P2P ainda não conectou. Aguarde...");
  }

  const videoConstraints = getVideoConstraints();
  const selectedPid = parseInt(audioProcessSelect.value, 10);
  const captureAudio = !isNaN(selectedPid) && selectedPid > 0;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints,
    audio: false,
  });

  currentStream = stream;
  updateViewerCount();

  if (captureAudio) {
    try {
      await startNativeAudio(selectedPid);
      stream.addTrack(nativeAudio.track);
    } catch (err) {
      console.error("Erro ao capturar áudio nativo:", err);
      showToast(
        "Não foi possível capturar o áudio do processo. Seguindo sem áudio...",
        "warning",
      );
    }
  }

  stream.getVideoTracks()[0].onended = () => stopShare();

  return peer.id;
}

function showUnmuteOverlay() {
  const existing = document.getElementById("unmute-overlay");
  if (existing) return;

  const wrapper = document.querySelector(".video-wrapper");
  if (!wrapper) return;

  const overlay = document.createElement("div");
  overlay.id = "unmute-overlay";
  overlay.className = "unmute-overlay";
  overlay.innerHTML = "🔊 Clique para ativar o som";

  overlay.addEventListener("click", () => {
    const video = document.getElementById("remote-video");
    video.muted = false;
    video.play().catch((e) => console.error("Erro ao ativar som:", e));
    overlay.remove();
  });

  wrapper.appendChild(overlay);
}

async function stopShare() {
  activeCalls.forEach((call) => call.close());
  activeCalls.clear();
  connectedViewers.clear();
  updateViewerCount();

  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }

  await stopNativeAudio();

  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }

  if (tauri) {
    await tauri.invoke("clear_room");
  }

  updateViewerCount();
  showScreen("idle");
  destroyPeer();
}

async function joinRoom(roomId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Tempo esgotado ao conectar na sala."));
    }, 10000);

    const conn = peer.connect(roomId, { reliable: true });

    conn.on("open", () => {
      clearTimeout(timeout);
      conn.send("viewer-ready");
      resolve();
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function answerCall(call) {
  call.answer();

  call.on("stream", (remoteStream) => {
    const video = document.getElementById("remote-video");
    video.srcObject = remoteStream;
    video.muted = false;

    video.onloadedmetadata = () => {
      video
        .play()
        .then(() => {
          showScreen("watching");
        })
        .catch((err) => {
          video.muted = true;
          video.play().then(() => {
            showUnmuteOverlay();
          });
          showScreen("watching");
        });
    };
  });

  call.on("error", (err) => {
    showToast("Erro na conexão. Voltando ao início...", "error");
    if (currentCall) {
      currentCall.close();
      currentCall = null;
    }
    showScreen("idle");
    destroyPeer();
  });

  call.on("close", () => {
    currentCall = null;
    showScreen("idle");
    destroyPeer();
  });

  currentCall = call;
}

async function handleDeepLinkRoom(roomId) {
  if (!roomId) return;

  if (deepLinkProcessed && roomId === lastProcessedRoom) return;
  deepLinkProcessed = true;
  lastProcessedRoom = roomId;

  if (currentStream) {
    showToast("Você já está compartilhando. Pare primeiro.", "warning");
    return;
  }

  try {
    await ensurePeer();

    if (roomId === peer.id) {
      showToast("Você não pode assistir à própria transmissão.", "error");
      return;
    }

    showToast("Entrando na sala...", "info", 2000);
    await joinRoom(roomId);
    showToast("Assistindo", "success");
  } catch (err) {
    console.error("Erro ao entrar pela sala:", err);
    showToast(err.message || "Erro ao conectar. Tente novamente.", "error");
    deepLinkProcessed = false;
  }
}

btnStart.addEventListener("click", async () => {
  try {
    if (tauri) {
      const result = await tauri.invoke("ensure_discord_rpc");
      if (!result) {
        showToast("Abra o Discord primeiro e tente novamente.", "error");
        return;
      }
    }

    await ensurePeer();
    showToast("Escolhendo tela...", "info", 2000);
    const roomId = await startShare();
    document.getElementById("room-id").textContent = roomId;

    if (tauri) {
      await tauri.invoke("update_room", { roomId });
    }

    showScreen("sharing");
    showToast("Ao vivo!", "success");
  } catch (err) {
    showToast(err.message || "Abra seu discord primeiro.", "error");
  }
});

document.getElementById("btn-stop").addEventListener("click", stopShare);

document.getElementById("btn-leave").addEventListener("click", () => {
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  showScreen("idle");
  destroyPeer();
});

document
  .getElementById("btn-video-fullscreen")
  .addEventListener("click", () => {
    const video = document.getElementById("remote-video");
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      video.requestFullscreen();
    }
  });

document.getElementById("btn-join").addEventListener("click", async () => {
  const roomId = document.getElementById("room-input").value.trim();
  if (!roomId) return;

  try {
    await ensurePeer();
    showToast("Conectando...", "info", 2000);
    await joinRoom(roomId);
    showToast("Assistindo", "success");
  } catch (err) {
    showToast(err.message || "Erro ao entrar na sala.", "error");
  }
});

document.getElementById("btn-copy").addEventListener("click", () => {
  const id = document.getElementById("room-id").textContent;
  navigator.clipboard.writeText(id);
  showToast("ID copiado!", "success", 1500);
});

btnRefreshProcesses.addEventListener("click", loadAudioProcesses);

document.getElementById("btn-min").addEventListener("click", () => {
  if (tauri) {
    tauri.invoke("minimize_window");
  }
});

document.getElementById("btn-close").addEventListener("click", () => {
  if (tauri) {
    tauri.invoke("close_window");
  }
});

if (tauri) {
  tauriEvent.listen("deep-link", (event) => {
    handleDeepLinkRoom(event.payload);
  });

  async function checkPendingDeepLink() {
    try {
      const roomId = await tauri.invoke("get_pending_deep_link");
      if (roomId) {
        handleDeepLinkRoom(roomId);
      }
    } catch (err) {
      console.error("Erro ao verificar deep link pendente:", err);
    }
  }

  tauri.invoke("renderer_ready");
  checkPendingDeepLink();

  loadAudioProcesses();
}

setStatus("⚪ Ocioso — clique em Compartilhar ou Assistir para conectar");
