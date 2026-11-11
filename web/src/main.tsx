import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ds/app.css";
import "./ds/patterns.css";
import "./ds/shell.css";
import "./ds/nav.css";
import "./ds/status-notice.css";
import "./web.css";

// The Rust client's default theme.
document.documentElement.dataset.theme = "forgeDark";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
