import { serve } from "@hono/node-server";
import { agents, createExampleApp } from "./app.js";

const port = Number(process.env.PORT ?? 8790);
const app = createExampleApp(process.env);

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(
    `service agents listening on http://127.0.0.1:${port} (${agents.length ? agents.join(", ") : "none"})`,
  );
});
