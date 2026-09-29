(() => {
  const button = document.getElementById("btnInstall");
  const hint = document.getElementById("installHint");
  const offlineHint = document.getElementById("offlineHint");
  const standalone = window.matchMedia("(display-mode: standalone)");
  let pendingPrompt = null;

  function isInstalled() {
    return standalone.matches || navigator.standalone === true;
  }

  function updateInstallUI() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    button.hidden = isInstalled() || !pendingPrompt;
    hint.hidden = isInstalled() || !ios || !!pendingPrompt;
    hint.textContent = "Per installare su iPhone o iPad: apri il sito in Safari, tocca Condividi e scegli Aggiungi alla schermata Home.";
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pendingPrompt = event;
    updateInstallUI();
  });

  button.addEventListener("click", async () => {
    if (!pendingPrompt) return;
    const prompt = pendingPrompt;
    pendingPrompt = null;
    updateInstallUI();
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      hint.textContent = "Per installare l'app, usa il menu del browser.";
      hint.hidden = false;
    }
  });

  window.addEventListener("appinstalled", () => {
    pendingPrompt = null;
    button.hidden = true;
    hint.hidden = true;
  });
  standalone.addEventListener("change", updateInstallUI);
  function updateConnection() {
    offlineHint.hidden = navigator.onLine;
  }
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  updateConnection();
  updateInstallUI();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" })
        .catch((error) => console.warn("Cache offline non disponibile:", error));
    });
  }
})();
