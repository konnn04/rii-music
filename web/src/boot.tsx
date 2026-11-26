import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { registerSW } from "virtual:pwa-register";
import { queryClient } from "./lib/queries";
import { setUnauthorizedHandler } from "./lib/api";
import { router } from "./router";
import { startAutofill } from "./player/autofill";
import { initLite } from "./lib/lite";
import { initDesktop } from "./lib/desktop";
import "./styles/app.css";

setUnauthorizedHandler(() => {
  queryClient.setQueryData(["me"], undefined);
  queryClient.invalidateQueries({ queryKey: ["me"] });
});

// A new version replaced the cached app while this page still runs the old one: a
// lazy page of the old version can't load any more (and offline, not at all).
// Reload once into the new version instead of showing a broken page.
window.addEventListener("vite:preloadError", (e) => {
  if (sessionStorage.getItem("rii-reloaded") === "1") return;
  e.preventDefault();
  sessionStorage.setItem("rii-reloaded", "1");
  location.reload();
});
window.setTimeout(() => sessionStorage.removeItem("rii-reloaded"), 10_000);

startAutofill();
initLite(); // fewer effects on weak devices
initDesktop();

if (import.meta.env.PROD) registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
