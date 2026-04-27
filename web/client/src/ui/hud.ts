import type { ArenaStateLike, KillEntryState, PlayerState } from "../net/client";
import type { Room } from "colyseus.js";

const SCOREBOARD_TIMEOUT = 4000;

/** Updates the in-match HUD: HP bar, ammo, kill feed, and toggleable scoreboard. */
export class Hud {
  private hpFill = document.getElementById("hp-fill") as HTMLDivElement;
  private ammo = document.getElementById("ammo") as HTMLDivElement;
  private feed = document.getElementById("kill-feed") as HTMLDivElement;
  private scoreboardEl = document.getElementById("scoreboard") as HTMLDivElement;
  private scoreboardOpenedAt = 0;
  private scoreboardManuallyOpen = false;

  private myId = "";

  constructor(private getMagazine: () => number) {}

  bind(room: Room<ArenaStateLike>, myId: string) {
    this.myId = myId;
    room.state.killFeed.onAdd((k: KillEntryState) => {
      this.appendKill(k);
    });
  }

  setHp(percent: number) {
    this.hpFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  setMagazine(_value: number) {
    this.ammo.textContent = String(this.getMagazine());
  }

  appendKill(k: KillEntryState) {
    const row = document.createElement("div");
    row.className = "row";
    const meVictim = k.victim === this.myId;
    const meAttacker = k.attacker === this.myId;
    const a = meAttacker ? `<span class="me">${escape(k.attacker)}</span>` : escape(k.attacker);
    const v = meVictim ? `<span class="me">${escape(k.victim)}</span>` : escape(k.victim);
    row.innerHTML = `${a} → ${v}`;
    this.feed.prepend(row);
    while (this.feed.children.length > 5) this.feed.lastElementChild?.remove();
    setTimeout(() => row.remove(), 5000);
  }

  toggleScoreboard(force?: boolean) {
    this.scoreboardManuallyOpen = force ?? !this.scoreboardManuallyOpen;
    this.scoreboardEl.classList.toggle("hidden", !this.scoreboardManuallyOpen);
    this.scoreboardOpenedAt = Date.now();
  }

  refreshScoreboard(state: ArenaStateLike) {
    if (!this.scoreboardManuallyOpen) {
      // Auto-show briefly on kills happens via toggleScoreboard(true) call from caller.
      return;
    }
    if (this.scoreboardManuallyOpen && Date.now() - this.scoreboardOpenedAt > SCOREBOARD_TIMEOUT * 4) {
      // Don't auto-close manually opened scoreboard.
    }
    const rows: PlayerState[] = [];
    state.players.forEach((p) => rows.push(p));
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const html = `
      <table>
        <thead><tr><th>Player</th><th>K</th><th>D</th></tr></thead>
        <tbody>
          ${rows.map((p) => `
            <tr class="${p.id === this.myId ? "me" : ""}">
              <td>${escape(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    this.scoreboardEl.innerHTML = html;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
