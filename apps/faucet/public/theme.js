// Applies a saved theme before paint. Without a saved choice the page follows prefers-color-scheme.
(function () {
  try {
    var t = localStorage.getItem("g402-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {
    /* storage blocked: follow the system setting */
  }
})();
