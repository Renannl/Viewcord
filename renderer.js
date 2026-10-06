const screens = {
  idle: document.getElementById("screen-idle"),
  sharing: document.getElementById("screen-sharing"),
  watching: document.getElementById("screen-watching"),
};

const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btn-start");

let peer = null;
let currentCall = null;
let currentStream = null;
let peerReady = false;

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function initPeer() {
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

    peer.on("open", (id) => {
      console.log("🆔 Meu ID P2P:", id);
      peerReady = true;
      btnStart.disabled = false;
      statusEl.textContent = "🟢 Conectado P2P — pronto pra compartilhar";
      resolve(id);
    });

    peer.on("error", (err) => {
      console.error("❌ Erro P2P:", err);
      statusEl.textContent = "❌ Erro P2P: " + err.message;
      reject(err);
    });

    peer.on("call", (call) => {
      call.answer();
      call.on("stream", (remoteStream) => {
        const video = document.getElementById("remote-video");
        video.srcObject = remoteStream;
        showScreen("watching");
      });
      currentCall = call;
    });
  });
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

async function startShare() {
  if (!peerReady || !peer.id) {
    throw new Error("P2P ainda não conectou. Aguarde...");
  }

  const source = await showSourcePicker();
  if (!source) throw new Error("Compartilhamento cancelado");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: source.id,
        minWidth: 1280,
        maxWidth: 1280,
        minHeight: 720,
        maxHeight: 720,
        maxFrameRate: 30,
      },
    },
  });

  currentStream = stream;
  const roomId = peer.id;

  peer.on("connection", (conn) => {
    conn.on("open", () => {
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
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  await window.viewcord.clearRoom();
  showScreen("idle");
  statusEl.textContent = "⚪ Parado";
}

async function joinRoom(roomId) {
  const conn = peer.connect(roomId);
  conn.on("open", () => {
    console.log("✅ Conectado na sala:", roomId);
  });
  conn.on("error", (err) => {
    console.error("Erro ao conectar:", err);
    statusEl.textContent = "❌ Sala não encontrada";
  });
}

// Event listeners
btnStart.addEventListener("click", async () => {
  try {
    statusEl.textContent = "🟡 Escolhendo tela...";
    const roomId = await startShare();
    document.getElementById("room-id").textContent = roomId;
    await window.viewcord.updateRoom(roomId);
    showScreen("sharing");
    statusEl.textContent = "🟢 Ao vivo";
  } catch (err) {
    statusEl.textContent = "❌ " + err.message;
  }
});

document.getElementById("btn-stop").addEventListener("click", stopShare);

document.getElementById("btn-leave").addEventListener("click", () => {
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  showScreen("idle");
  statusEl.textContent = "⚪ Parado";
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
    statusEl.textContent = "🟡 Conectando...";
    await joinRoom(roomId);
    showScreen("watching");
    statusEl.textContent = "🟢 Assistindo";
  } catch (err) {
    statusEl.textContent = "❌ " + err.message;
  }
});

document.getElementById("btn-copy").addEventListener("click", () => {
  const id = document.getElementById("room-id").textContent;
  navigator.clipboard.writeText(id);
  document.getElementById("btn-copy").textContent = "✅";
  setTimeout(() => {
    document.getElementById("btn-copy").textContent = "📋";
  }, 1500);
});

window.viewcord.onDeepLink((roomId) => {
  if (currentStream) {
    console.warn("⚠️ Já está compartilhando. Ignorando deep link.");
    statusEl.textContent = "⚠️ Você já está compartilhando. Pare primeiro.";
    return;
  }

  if (roomId === peer.id) {
    console.warn("⚠️ Tentando entrar na própria sala.");
    statusEl.textContent = "⚠️ Você não pode assistir à própria transmissão.";
    return;
  }

  document.getElementById("room-input").value = roomId;
  document.getElementById("btn-join").click();
});

btnStart.disabled = true;
statusEl.textContent = "🟡 Conectando P2P...";

initPeer().catch(console.error);
