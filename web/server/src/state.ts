import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

/** Replicated per-player state. */
export class Player extends Schema {
  @type("string") id = "";
  @type("string") name = "Player";
  @type("string") skin = "neon";
  @type("number") x = 0;
  @type("number") y = 1.6;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("number") pitch = 0;
  @type("number") hp = 100;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("number") lastShotAt = 0;
  @type("number") respawnAt = 0;
}

/** A row in the recent-kill log; rendered by clients as the kill feed.
 *  `attackerId` / `victimId` carry session ids so clients can highlight
 *  rows involving the local player; the name fields are display only. */
export class KillEntry extends Schema {
  @type("string") attackerId = "";
  @type("string") victimId = "";
  @type("string") attacker = "";
  @type("string") victim = "";
  @type("number") at = 0;
}

export class ArenaState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([KillEntry]) killFeed = new ArraySchema<KillEntry>();
  @type("number") tick = 0;
}
