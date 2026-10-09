import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { StreamProvider } from "./lib/stream.tsx";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StreamProvider>
      <App />
    </StreamProvider>
  </StrictMode>,
);
