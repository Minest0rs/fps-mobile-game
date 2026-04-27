import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { ArenaRoom } from "./ArenaRoom.js";

const PORT = Number(process.env.PORT ?? 2567);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");

const app = express();
app.use(cors());
app.get("/healthz", (_, res) => res.json({ ok: true, ts: Date.now() }));

// Colyseus admin monitor — exposes room/state/connection management. Only
// mount in non-production unless an admin password is provided, otherwise
// production deployments would expose a public admin panel.
if (process.env.NODE_ENV !== "production") {
  app.use("/colyseus", monitor());
} else if (process.env.MONITOR_PASSWORD) {
  app.use("/colyseus", (req, res, next) => {
    const header = req.headers.authorization ?? "";
    const expected = "Basic " + Buffer.from(`admin:${process.env.MONITOR_PASSWORD}`).toString("base64");
    if (header === expected) return next();
    res.set("WWW-Authenticate", 'Basic realm="colyseus"');
    res.status(401).send("Authentication required");
  }, monitor());
}

// Serve the built client at the root so the browser hits a single origin —
// basic-auth credentials are then reused for the WebSocket upgrade.
app.use(express.static(CLIENT_DIST));
app.get("*", (_, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("arena", ArenaRoom);

gameServer.listen(PORT).then(() => {
  console.log(`[server] arena + client listening on :${PORT}`);
});
