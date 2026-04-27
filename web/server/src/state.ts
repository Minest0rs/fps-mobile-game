import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

/** Replicated per-player state. */
export class Player extends Schema {
  @type("string") id = "";
  @type("string") name = "Player";
  @type("string") skin = "neon";
  @type("string") weapon = "rifle";
  @type("boolean") isBot = false;
  @type("number") x = 0;
  @type("number") y = 1.6;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("number") pitch = 0;
  @type("number") hp = 100;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  // Server-only fields (not replicated): cooldown enforcement, respawn
  // scheduling, and bot AI scratch state are pure server logic.
  lastShotAt = 0;
  /** Pellets fired in the current trigger pull — shotguns send `pellets`
   *  shoot messages per pull, so we count them here to avoid resetting the
   *  fire-rate timer in the middle of a burst. */
  shotsInBurst = 0;
  respawnAt = 0;
  /** Bot-only: where the bot is currently walking toward. */
  botTargetX = 0;
  botTargetZ = 0;
  /** Bot-only: difficulty modifier set at spawn time. */
  botSkill = 1;
}

/** A row in the recent-kill log; rendered by clients as the kill feed. */
export class KillEntry extends Schema {
  @type("string") attackerId = "";
  @type("string") victimId = "";
  @type("string") attacker = "";
  @type("string") victim = "";
  @type("number") at = 0;
}

/** Toggleable match-wide effects, set once by the host on room creation
 *  and then read by every client to apply visual / gameplay mods. */
export class MatchEvents extends Schema {
  @type("boolean") night = false;
  @type("boolean") lowGravity = false;
  @type("boolean") meteorShower = false;
  @type("boolean") fog = false;
  @type("boolean") thunderstorm = false;
  @type("boolean") sandstorm = false;
}

export class ArenaState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([KillEntry]) killFeed = new ArraySchema<KillEntry>();
  @type("number") tick = 0;
  @type(MatchEvents) events = new MatchEvents();
}
