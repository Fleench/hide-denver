"use strict";

if ("serviceWorker" in navigator) {
  let refreshing = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) {
      return;
    }

    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        if (!registration.active) {
          return null;
        }

        return registration.update().catch((error) => {
          console.warn("Service worker update check failed.", error);
        });
      })
      .catch((error) => {
        console.warn("Service worker registration failed.", error);
      });
  });
}
