(() => {
  let preference = "system";
  try {
    preference = localStorage.getItem("opsifier.theme") || "system";
  } catch {}
  const dark =
    preference === "dark" || (preference !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
