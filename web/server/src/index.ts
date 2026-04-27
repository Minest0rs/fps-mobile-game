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
app.use("/colyseus", monitor());

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
