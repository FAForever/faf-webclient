import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { siteConfig } from "./auth";
import { setBaseDomain } from "./hosts";
import "./ds/app.css";
import "./ds/patterns.css";
import "./ds/shell.css";
import "./ds/nav.css";
import "./ds/status-notice.css";
import "./web.css";

// The Rust client's default theme.
document.documentElement.dataset.theme = "forgeDark";

// Links and images point at FAF's real or test servers, whichever this server
// belongs to. Rendering waits for that answer, but never longer than 2 s.
const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
void Promise.race([siteConfig(), timeout]).then((config) => {
  setBaseDomain(config?.baseDomain);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
