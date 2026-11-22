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
import "./styles/app.css";

setUnauthorizedHandler(() => {
  queryClient.setQueryData(["me"], undefined);
  queryClient.invalidateQueries({ queryKey: ["me"] });
});

startAutofill();
initLite(); // fewer effects on weak devices

if (import.meta.env.PROD) registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
