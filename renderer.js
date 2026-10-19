const screens = {
  idle: document.getElementById("screen-idle"),
  sharing: document.getElementById("screen-sharing"),
  watching: document.getElementById("screen-watching"),
};

const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btn-start");
const qualitySelect = document.getElementById("quality-select");
const captureAudioCheckbox = document.getElementById("capture-audio");

let peer = null;
let currentCall = null;
let currentStream = null;
let peerReady = false;
let pendingDeepLinkRoom = null;
let peerConnecting = false;
let globalCallListenerSet = false;

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

    // ------------- HOST: recebe conexão de dados e inicia a call -------------
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

async function showSourcePicker() {
  const sources = await window.viewcord.getSources();

  const modal = document.createElement("div");
  modal.className = "source-picker-modal";
  modal.innerHTML = `
    <div class="source-picker">
      <h3>Escolha o que compartilhar</h3>
      <div class="sources-grid">
        ${sources
          .map(
            (source, idx) => `
          <div class="source-item" data-idx="${idx}">
            <img src="${source.thumbnail}" alt="${source.name}">
            <span>${source.name}</span>
          </div>
        `,
          )
          .join("")}
      </div>
      <button class="btn-cancel">Cancelar</button>
    </div>
  `;

  document.body.appendChild(modal);

  return new Promise((resolve) => {
    modal.querySelectorAll(".source-item").forEach((item) => {
      item.addEventListener("click", () => {
        const idx = parseInt(item.dataset.idx);
        document.body.removeChild(modal);
        resolve(sources[idx]);
      });
    });

    modal.querySelector(".btn-cancel").addEventListener("click", () => {
      document.body.removeChild(modal);
      resolve(null);
    });
  });
}

function getVideoConstraints(sourceId) {
  const quality = qualitySelect.value;
  const base = {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: sourceId,
  };

  if (quality === "fhd") {
    return {
      ...base,
      minWidth: 1920,
      maxWidth: 1920,
      minHeight: 1080,
      maxHeight: 1080,
      maxFrameRate: 60,
    };
  }

  return {
    ...base,
    minWidth: 1280,
    maxWidth: 1280,
    minHeight: 720,
    maxHeight: 720,
    maxFrameRate: 30,
  };
}

async function startShare() {
  if (!peerReady || !peer.id) {
    throw new Error("P2P ainda não conectou. Aguarde...");
  }

  const source = await showSourcePicker();
  if (!source) throw new Error("Compartilhamento cancelado");

  const captureAudio = captureAudioCheckbox.checked;

  const videoConstraints = getVideoConstraints(source.id);
  const audioConstraints = captureAudio
    ? {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: source.id,
        },
      }
    : false;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: { mandatory: videoConstraints },
    });
  } catch (err) {
    if (captureAudio) {
      showToast(
        "Não foi possível capturar o áudio da janela. Tentando sem áudio...",
        "warning",
      );
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: videoConstraints },
      });
    } else {
      throw err;
    }
  }

  currentStream = stream;
  const roomId = peer.id;

  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    showToast(`Áudio: ${audioTrack.label || "ativo"}`, "success", 2000);
  } else if (captureAudio) {
    showToast(
      "Esta fonte não emite som. O áudio só é capturado se a janela/tela estiver reproduzindo áudio.",
      "warning",
      5000,
    );
  }

  stream.getVideoTracks()[0].onended = () => {
    stopShare();
  };

  return roomId;
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
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  await window.viewcord.clearRoom();
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
      // Avisa o host que o viewer está pronto para receber a call
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
          // Se o navegador bloquear áudio, tenta mudo e oferece botão para ativar
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

btnStart.addEventListener("click", async () => {
  const result = await window.viewcord.ensureDiscord();
  if (!result.ok) {
    showToast("Abra o Discord primeiro e tente novamente.", "error");
    return;
  }

  try {
    await ensurePeer();
    showToast("Escolhendo tela...", "info", 2000);
    const roomId = await startShare();
    document.getElementById("room-id").textContent = roomId;

    const update = await window.viewcord.updateRoom(roomId);
    if (!update.ok) {
      showToast(update.message, "error");
      return;
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

window.viewcord.onDeepLink((roomId) => {
  console.log("Deep link recebido no renderer (push):", roomId);
  handleDeepLinkRoom(roomId);
});

async function checkPendingDeepLink() {
  console.log("Verificando deep link pendente...");
  try {
    const roomId = await window.viewcord.getPendingDeepLink();
    console.log("Deep link pendente:", roomId);
    if (roomId) {
      handleDeepLinkRoom(roomId);
    }
  } catch (err) {
    console.error("Erro ao verificar deep link pendente:", err);
  }
}

window.viewcord.send("renderer-ready");

checkPendingDeepLink();

setStatus("⚪ Ocioso — clique em Compartilhar ou Assistir para conectar");
