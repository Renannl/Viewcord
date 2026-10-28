// ===== Referências DOM =====
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

const tauri = window.__TAURI__?.core;
const tauriEvent = window.__TAURI__?.event;

// ===== Estado da captura nativa de áudio =====
let nativeAudio = null; // { context, processor, destination, track, pcmBuffer, pcmLength, unlisten }

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toast-container");

  const icons = {
    error: "⚠️",
    success: "✅",
    info: "ℹ️",
    warning: "⚠️",
  };

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove());
  }, duration);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function destroyPeer() {
  if (!peer) return;
  console.log("Destruindo peer para economizar RAM");
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
    console.log("Call recebida de:", call.peer);
    answerCall(call);
  });
}

function initPeer() {
  if (peerConnecting) {
    console.log("Peer já está conectando, aguardando...");
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
      conn.on("open", () => {
        console.log("Conexão de dados aberta com:", conn.peer);
      });

      conn.on("data", (data) => {
        if (data === "viewer-ready" && currentStream) {
          console.log("Viewer pronto. Iniciando call...");
          const videoTrack = currentStream.getVideoTracks()[0];
          if (!videoTrack || videoTrack.readyState !== "live") {
            console.warn("Stream não está ativa, não iniciando call");
            return;
          }

          currentCall = peer.call(conn.peer, currentStream);

          currentCall.on("error", (err) => {
            console.error("Erro na call (host):", err);
            showToast("Erro na transmissão. Encerrando...", "error");
            stopShare();
          });

          currentCall.on("close", () => {
            console.log("Call fechada (host)");
            currentCall = null;
          });
        }
      });

      conn.on("error", (err) => {
        console.error("Erro na conexão de dados:", err);
      });
    });

    peer.on("open", (id) => {
      console.log("Meu ID P2P:", id);
      peerReady = true;
      peerConnecting = false;
      btnStart.disabled = false;
      setStatus("🟢 Conectado P2P — pronto pra compartilhar");

      setupGlobalCallListener();

      if (pendingDeepLinkRoom) {
        console.log("Processando deep link pendente:", pendingDeepLinkRoom);
        const roomId = pendingDeepLinkRoom;
        pendingDeepLinkRoom = null;
        handleDeepLinkRoom(roomId);
      }

      resolve(id);
    });

    peer.on("error", (err) => {
      console.error("❌ Erro P2P:", err);
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

// ===== Captura de áudio nativo por processo =====

function toUint8Array(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (Array.isArray(payload)) return new Uint8Array(payload);
  if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    return new Uint8Array(payload.data);
  }
  return null;
}

function bytesToFloat32(bytes) {
  // PCM 16-bit interleaved little-endian (nativo do Windows) -> Float32
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
    console.warn("Captura nativa de áudio já está ativa");
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx({ sampleRate: 48000 });

  const destination = context.createMediaStreamDestination();
  // 4096 amostras por canal (~85ms) — buffer folgado contra underrun
  const processor = context.createScriptProcessor(4096, 2, 2);

  const state = {
    context,
    destination,
    processor,
    track: destination.stream.getAudioTracks()[0],
    pcmBuffer: new Float32Array(48000 * 2 * 2), // ~2s de PCM interleaved
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

  console.log(`Captura de áudio nativo iniciada para PID ${pid}`);
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

    console.log(`Processos de áudio carregados: ${processes.length}`);
  } catch (err) {
    showToast(`Erro ao listar processos: ${err}`, "error", 5000);
  } finally {
    btnRefreshProcesses.disabled = false;
    btnRefreshProcesses.textContent = "↻ Atualizar";
  }
}

async function startShare() {
  if (!peerReady || !peer.id) {
    throw new Error("P2P ainda não conectou. Aguarde...");
  }

  const videoConstraints = getVideoConstraints();
  const selectedPid = parseInt(audioProcessSelect.value, 10);
  const captureAudio = !isNaN(selectedPid) && selectedPid > 0;

  // Vídeo sempre; o áudio (se solicitado) vem da captura nativa por processo
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints,
    audio: false,
  });

  currentStream = stream;

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
      console.log("✅ Conectado na sala:", roomId);
      conn.send("viewer-ready");
      resolve();
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      console.error("Erro ao conectar:", err);
      reject(err);
    });
  });
}

function answerCall(call) {
  console.log("answerCall iniciado");
  call.answer();

  call.on("stream", (remoteStream) => {
    console.log("Stream remoto recebido:", remoteStream);
    console.log("Áudio tracks:", remoteStream.getAudioTracks());

    const video = document.getElementById("remote-video");
    video.srcObject = remoteStream;
    video.muted = false;

    video.onloadedmetadata = () => {
      video
        .play()
        .then(() => {
          console.log("Vídeo tocando com áudio");
          showScreen("watching");
        })
        .catch((err) => {
          console.error("Erro ao dar play:", err);
          video.muted = true;
          video.play().then(() => {
            console.log("Vídeo tocando mudo — aguardando interação");
            showUnmuteOverlay();
          });
          showScreen("watching");
        });
    };
  });

  call.on("error", (err) => {
    console.error("Erro na call (viewer):", err);
    showToast("Erro na conexão. Voltando ao início...", "error");
    if (currentCall) {
      currentCall.close();
      currentCall = null;
    }
    showScreen("idle");
    destroyPeer();
  });

  call.on("close", () => {
    console.log("Call fechada (viewer)");
    currentCall = null;
    showScreen("idle");
    destroyPeer();
  });

  currentCall = call;
}

async function handleDeepLinkRoom(roomId) {
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
    showToast(err.message || "Erro ao conectar. Tente novamente.", "error");
  }
}

// ===== Event listeners =====
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
    showToast(err.message || "Erro ao iniciar compartilhamento.", "error");
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

// Window controls
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

// Deep link handling
if (tauri) {
  tauriEvent.listen("deep-link", (event) => {
    console.log("Deep link recebido (push):", event.payload);
    handleDeepLinkRoom(event.payload);
  });

  async function checkPendingDeepLink() {
    console.log("Verificando deep link pendente...");
    try {
      const roomId = await tauri.invoke("get_pending_deep_link");
      console.log("Deep link pendente:", roomId);
      if (roomId) {
        handleDeepLinkRoom(roomId);
      }
    } catch (err) {
      console.error("Erro ao verificar deep link pendente:", err);
    }
  }

  tauri.invoke("renderer_ready");
  checkPendingDeepLink();

  // Carrega a lista de processos para captura de áudio
  loadAudioProcesses();
}

setStatus("⚪ Ocioso — clique em Compartilhar ou Assistir para conectar");
