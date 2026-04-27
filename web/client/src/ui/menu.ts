import { Profile, SKINS, isSkinUnlocked, save, xpToReach, load } from "../profile";

/** Wires the main-menu form to a profile and resolves the user's choices. */
export interface MenuResult {
  name: string;
  skin: string;
}

export function setupMenu(onPlay: (r: MenuResult) => void) {
  const nameInput = document.getElementById("name-input") as HTMLInputElement;
  const skinSelect = document.getElementById("skin-select") as HTMLSelectElement;
  const playButton = document.getElementById("play-button") as HTMLButtonElement;
  const status = document.getElementById("status") as HTMLParagraphElement;
  const profileLine = document.getElementById("profile-line") as HTMLParagraphElement;

  const profile = load();
  nameInput.value = profile.name;
  rebuildSkinOptions(skinSelect, profile);
  skinSelect.value = profile.skin;
  profileLine.textContent = `Lv ${profile.level} · ${profile.xp}/${xpToReach(profile.level + 1)} XP`;

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

  playButton.addEventListener("click", () => {
    const name = (nameInput.value || "Player").slice(0, 20);
    profile.name = name;
    save(profile);
    onPlay({ name, skin: profile.skin });
  });

  return {
    setStatus: (s: string) => { status.textContent = s; },
    hide: () => document.getElementById("menu")!.classList.add("hidden"),
    show: () => document.getElementById("menu")!.classList.remove("hidden"),
    refreshProfile: () => {
      const p = load();
      profileLine.textContent = `Lv ${p.level} · ${p.xp}/${xpToReach(p.level + 1)} XP`;
      rebuildSkinOptions(skinSelect, p);
      skinSelect.value = p.skin;
    },
  };
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
