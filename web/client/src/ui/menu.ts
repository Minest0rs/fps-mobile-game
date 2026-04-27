import { Profile, SKINS, isSkinUnlocked, save, xpToReach, load } from "../profile";
import { WEAPONS, getWeapon } from "../weapons";

/** Wires the main-menu form to a profile and resolves the user's choices. */
export interface MatchOptions {
  bots: { enabled: boolean; count: number; difficulty: "easy" | "normal" | "hard" };
  events: { night: boolean; lowGravity: boolean; meteorShower: boolean; fog: boolean };
}

export interface MenuResult {
  name: string;
  skin: string;
  weapon: string;
  /** When true, request a fresh room with our `match` options as the host config.
   *  When false, drop into the first available public match. */
  createMatch: boolean;
  match: MatchOptions;
}

export function setupMenu(onPlay: (r: MenuResult) => void) {
  const nameInput = document.getElementById("name-input") as HTMLInputElement;
  const skinSelect = document.getElementById("skin-select") as HTMLSelectElement;
  const weaponSelect = document.getElementById("weapon-select") as HTMLSelectElement;
  const weaponLine = document.getElementById("weapon-line") as HTMLParagraphElement;
  const findBtn = document.getElementById("find-match") as HTMLButtonElement;
  const createBtn = document.getElementById("create-match") as HTMLButtonElement;
  const status = document.getElementById("status") as HTMLParagraphElement;
  const profileLine = document.getElementById("profile-line") as HTMLParagraphElement;

  const botsEnabled = document.getElementById("bots-enabled") as HTMLInputElement;
  const botsCount = document.getElementById("bots-count") as HTMLInputElement;
  const botsDifficulty = document.getElementById("bots-difficulty") as HTMLSelectElement;
  const evNight = document.getElementById("ev-night") as HTMLInputElement;
  const evLowGrav = document.getElementById("ev-lowgrav") as HTMLInputElement;
  const evMeteor = document.getElementById("ev-meteor") as HTMLInputElement;
  const evFog = document.getElementById("ev-fog") as HTMLInputElement;

  const profile = load();
  nameInput.value = profile.name;
  rebuildSkinOptions(skinSelect, profile);
  skinSelect.value = profile.skin;
  rebuildWeaponOptions(weaponSelect);
  weaponSelect.value = profile.weapon || "rifle";
  refreshWeaponBlurb(weaponSelect, weaponLine);
  profileLine.textContent = `Lv ${profile.level} · ${profile.xp}/${xpToReach(profile.level + 1)} XP`;

  // Restore last match settings from local storage.
  const saved = loadMatchOptions();
  botsEnabled.checked = saved.bots.enabled;
  botsCount.value = String(saved.bots.count);
  botsDifficulty.value = saved.bots.difficulty;
  evNight.checked = saved.events.night;
  evLowGrav.checked = saved.events.lowGravity;
  evMeteor.checked = saved.events.meteorShower;
  evFog.checked = saved.events.fog;

  skinSelect.addEventListener("change", () => {
    if (!isSkinUnlocked(profile, skinSelect.value)) {
      status.textContent = `${SKINS[skinSelect.value].label} unlocks at level ${SKINS[skinSelect.value].unlock}`;
      skinSelect.value = profile.skin;
      return;
    }
    status.textContent = "";
    profile.skin = skinSelect.value;
    save(profile);
  });

  weaponSelect.addEventListener("change", () => {
    profile.weapon = weaponSelect.value;
    save(profile);
    refreshWeaponBlurb(weaponSelect, weaponLine);
  });

  const collect = (createMatch: boolean): MenuResult => {
    const name = (nameInput.value || "Player").slice(0, 20);
    profile.name = name;
    profile.weapon = weaponSelect.value;
    save(profile);
    const match: MatchOptions = {
      bots: {
        enabled: botsEnabled.checked,
        count: clampInt(parseInt(botsCount.value, 10), 0, 8),
        difficulty: (botsDifficulty.value as MatchOptions["bots"]["difficulty"]) || "normal",
      },
      events: {
        night: evNight.checked,
        lowGravity: evLowGrav.checked,
        meteorShower: evMeteor.checked,
        fog: evFog.checked,
      },
    };
    saveMatchOptions(match);
    return { name, skin: profile.skin, weapon: profile.weapon || "rifle", createMatch, match };
  };

  const onClick = (createMatch: boolean) => () => {
    // Fullscreen / orientation lock MUST be requested directly from the
    // user-gesture stack, before any awaits, or mobile browsers reject it.
    if (isTouchDevice()) requestFullscreenAndLandscape();
    onPlay(collect(createMatch));
  };
  findBtn.addEventListener("click", onClick(false));
  createBtn.addEventListener("click", onClick(true));

  return {
    setStatus: (s: string) => { status.textContent = s; },
    hide: () => document.getElementById("menu")!.classList.add("hidden"),
    show: () => document.getElementById("menu")!.classList.remove("hidden"),
    refreshProfile: () => {
      const p = load();
      profileLine.textContent = `Lv ${p.level} · ${p.xp}/${xpToReach(p.level + 1)} XP`;
      rebuildSkinOptions(skinSelect, p);
      skinSelect.value = p.skin;
      weaponSelect.value = p.weapon || "rifle";
    },
  };
}

function clampInt(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

function requestFullscreenAndLandscape() {
  const root = document.documentElement;
  const fs = root.requestFullscreen?.bind(root)
    ?? (root as any).webkitRequestFullscreen?.bind(root);
  if (fs) {
    Promise.resolve(fs({ navigationUI: "hide" }))
      .then(() => {
        const orient = (screen as any).orientation;
        if (orient && typeof orient.lock === "function") {
          return orient.lock("landscape").catch(() => {});
        }
      })
      .catch((e) => console.warn("fullscreen failed:", e));
  }
}

function rebuildSkinOptions(select: HTMLSelectElement, profile: Profile) {
  select.innerHTML = "";
  for (const [id, def] of Object.entries(SKINS)) {
    const opt = document.createElement("option");
    opt.value = id;
    const locked = profile.level < def.unlock;
    opt.textContent = locked ? `${def.label} (Lv ${def.unlock})` : def.label;
    if (locked) opt.disabled = true;
    select.appendChild(opt);
  }
}

function rebuildWeaponOptions(select: HTMLSelectElement) {
  select.innerHTML = "";
  for (const [id, def] of Object.entries(WEAPONS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = def.label;
    select.appendChild(opt);
  }
}

function refreshWeaponBlurb(select: HTMLSelectElement, line: HTMLParagraphElement) {
  const w = getWeapon(select.value);
  line.textContent = `${w.blurb} · ${w.damage} dmg · ${Math.round(60000 / w.fireRateMs)} rpm · ${w.magSize} mag`;
}

const STORE_KEY = "arena.match.options.v1";

function loadMatchOptions(): MatchOptions {
  const fallback: MatchOptions = {
    bots: { enabled: false, count: 3, difficulty: "normal" },
    events: { night: false, lowGravity: false, meteorShower: false, fog: false },
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      bots: { ...fallback.bots, ...(parsed?.bots ?? {}) },
      events: { ...fallback.events, ...(parsed?.events ?? {}) },
    };
  } catch {
    return fallback;
  }
}

function saveMatchOptions(m: MatchOptions) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch {}
}
