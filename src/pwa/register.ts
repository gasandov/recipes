if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const url = new URL("./sw.js", document.baseURI);
  void navigator.serviceWorker.register(url).catch((error: unknown) => {
    console.error("Service worker registration failed.", error);
  });
}
