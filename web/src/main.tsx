import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import { App } from "./App.tsx";
import "./styles.css";

ModuleRegistry.registerModules([AllCommunityModule]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// AG Grid's colorSchemeVariable reads this attribute; follow the OS theme.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const syncTheme = () => (document.body.dataset.agThemeMode = media.matches ? "dark" : "light");
syncTheme();
media.addEventListener("change", syncTheme);
