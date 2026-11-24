(function () {
  "use strict";

  const STRINGS = {
    vi: {
      subtitle: "Chọn cách bạn muốn nghe nhạc",
      localTitle: "Nghe trên máy này (Local)",
      localDesc: "Không cần tài khoản. Nhạc được lưu mã hóa ngay trong thư mục nhạc trên máy.",
      musicDirLabel: "Thư mục nhạc",
      changeBtn: "Đổi…",
      clientTitle: "Kết nối máy chủ RiiMusic",
      clientDesc: "Kết nối tới máy chủ RiiMusic sẵn có để đồng bộ thư viện và danh sách phát.",
      serverUrlLabel: "Địa chỉ máy chủ",
      checkBtn: "Kiểm tra",
      checking: "Đang kiểm tra…",
      autostartLabel: "Mở cùng máy tính",
      closeToTrayLabel: "Đóng cửa sổ thì thu xuống khay",
      startBtn: "Bắt đầu",
      startingBtn: "Đang khởi động…",
      startingTitle: "Đang khởi động RiiMusic…",
      startingHint: "Lần đầu ở chế độ Local có thể mất một lúc để tải PostgreSQL / ffmpeg.",
      errEmptyUrl: "Vui lòng nhập địa chỉ máy chủ (ví dụ: https://music.example.com).",
      errEmptyDir: "Vui lòng chọn thư mục lưu nhạc.",
      okPrefix: "✓ Phiên bản ",
    },
    en: {
      subtitle: "Choose how you want to listen",
      localTitle: "Listen on this device (Local)",
      localDesc: "No account needed. Music is stored encrypted in your local music folder.",
      musicDirLabel: "Music folder",
      changeBtn: "Change…",
      clientTitle: "Connect to a RiiMusic server",
      clientDesc: "Connect to an existing RiiMusic server to sync your library and playlists.",
      serverUrlLabel: "Server URL",
      checkBtn: "Test",
      checking: "Checking…",
      autostartLabel: "Launch on startup",
      closeToTrayLabel: "Minimize to tray on close",
      startBtn: "Start",
      startingBtn: "Starting…",
      startingTitle: "Starting RiiMusic…",
      startingHint: "First launch in Local mode may take a moment to download PostgreSQL / ffmpeg.",
      errEmptyUrl: "Please enter a server URL (e.g. https://music.example.com).",
      errEmptyDir: "Please choose a music folder.",
      okPrefix: "✓ Version ",
    },
  };

  const lang = (navigator.language || "vi").toLowerCase().startsWith("vi") ? "vi" : "en";
  const dict = STRINGS[lang] || STRINGS.vi;
  document.documentElement.lang = lang;

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (dict[key]) {
        el.textContent = dict[key];
      }
    });
  }

  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core ? tauri.core.invoke : null;
  const listen = tauri && tauri.event ? tauri.event.listen : null;

  const viewSetup = document.getElementById("view-setup");
  const viewStarting = document.getElementById("view-starting");
  const errorBanner = document.getElementById("error-banner");
  const cardLocal = document.getElementById("card-local");
  const cardClient = document.getElementById("card-client");
  const inputMusicDir = document.getElementById("music-dir");
  const inputServerUrl = document.getElementById("server-url");
  const btnPickDir = document.getElementById("btn-pick-dir");
  const btnCheckServer = document.getElementById("btn-check-server");
  const serverStatus = document.getElementById("server-status");
  const optAutostart = document.getElementById("opt-autostart");
  const optCloseToTray = document.getElementById("opt-close-to-tray");
  const btnStart = document.getElementById("btn-start");
  const splashLog = document.getElementById("splash-log");

  let selectedMode = "local";
  let startMinimized = false;

  function setError(msg) {
    if (!msg) {
      errorBanner.textContent = "";
      errorBanner.classList.add("hidden");
      return;
    }
    errorBanner.textContent = String(msg);
    errorBanner.classList.remove("hidden");
  }

  function selectMode(mode) {
    selectedMode = mode === "client" ? "client" : "local";
    const isLocal = selectedMode === "local";
    cardLocal.classList.toggle("active", isLocal);
    cardLocal.setAttribute("aria-checked", String(isLocal));
    cardClient.classList.toggle("active", !isLocal);
    cardClient.setAttribute("aria-checked", String(!isLocal));
    setError("");
  }

  function updateViewFromHash() {
    const isStarting = window.location.hash === "#starting";
    viewSetup.classList.toggle("hidden", isStarting);
    viewStarting.classList.toggle("hidden", !isStarting);
  }

  [cardLocal, cardClient].forEach((card) => {
    card.addEventListener("click", () => {
      selectMode(card.getAttribute("data-mode"));
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        if (e.target === card) {
          e.preventDefault();
          selectMode(card.getAttribute("data-mode"));
        }
      }
    });
  });

  inputServerUrl.addEventListener("focus", () => selectMode("client"));

  btnPickDir.addEventListener("click", async (e) => {
    e.stopPropagation();
    selectMode("local");
    if (!invoke) return;
    try {
      const picked = await invoke("pick_music_dir", {
        defaultPath: inputMusicDir.value || null,
      });
      if (picked) {
        inputMusicDir.value = picked;
      }
    } catch (err) {
      setError(err);
    }
  });

  btnCheckServer.addEventListener("click", async (e) => {
    e.stopPropagation();
    selectMode("client");
    const url = inputServerUrl.value.trim();
    if (!url) {
      serverStatus.textContent = dict.errEmptyUrl;
      serverStatus.className = "status-line err";
      return;
    }
    if (!invoke) return;
    btnCheckServer.disabled = true;
    serverStatus.textContent = dict.checking;
    serverStatus.className = "status-line";
    try {
      const version = await invoke("check_server", { url });
      serverStatus.textContent = dict.okPrefix + version;
      serverStatus.className = "status-line ok";
    } catch (err) {
      serverStatus.textContent = String(err);
      serverStatus.className = "status-line err";
    } finally {
      btnCheckServer.disabled = false;
    }
  });

  btnStart.addEventListener("click", async () => {
    setError("");
    const musicDir = inputMusicDir.value.trim();
    const serverUrl = inputServerUrl.value.trim();

    if (selectedMode === "local" && !musicDir) {
      setError(dict.errEmptyDir);
      return;
    }
    if (selectedMode === "client" && !serverUrl) {
      setError(dict.errEmptyUrl);
      return;
    }
    if (!invoke) return;

    btnStart.disabled = true;
    btnStart.textContent = dict.startingBtn;
    try {
      await invoke("save_setup", {
        config: {
          mode: selectedMode,
          serverUrl,
          musicDir,
          autostart: optAutostart.checked,
          closeToTray: optCloseToTray.checked,
          startMinimized,
        },
      });
      window.location.hash = "#starting";
      updateViewFromHash();
    } catch (err) {
      setError(err);
      btnStart.disabled = false;
      btnStart.textContent = dict.startBtn;
    }
  });

  window.addEventListener("hashchange", updateViewFromHash);

  async function init() {
    applyI18n();
    updateViewFromHash();

    if (listen) {
      listen("sidecar-log", (event) => {
        if (event && typeof event.payload === "string" && event.payload.trim()) {
          splashLog.textContent = event.payload.trim();
        }
      });
      listen("sidecar-error", (event) => {
        if (event && event.payload) {
          window.location.hash = "";
          updateViewFromHash();
          setError(event.payload);
          btnStart.disabled = false;
          btnStart.textContent = dict.startBtn;
        }
      });
    }

    if (!invoke) return;
    try {
      const state = await invoke("get_setup_state");
      if (state && state.config) {
        inputMusicDir.value = state.config.musicDir || state.defaultMusicDir || "";
        inputServerUrl.value = state.config.serverUrl || "";
        optAutostart.checked = Boolean(state.config.autostart);
        optCloseToTray.checked = state.config.closeToTray !== false;
        startMinimized = Boolean(state.config.startMinimized);
        if (state.config.mode === "client") {
          selectMode("client");
        } else {
          selectMode("local");
        }
      }
      if (state && state.lastError) {
        setError(state.lastError);
      }
      if (state && state.starting && window.location.hash !== "#starting") {
        window.location.hash = "#starting";
        updateViewFromHash();
      }
    } catch (err) {
      setError(err);
    }
  }

  init();
})();
