# FPS Mobile (Unity, Android)

A networked 3D first-person shooter starter project for Android. Players join a public lobby, fight in a shared arena with hitscan firearms, earn XP that grades into levels, and equip cosmetic skins. Networking uses Unity Netcode for GameObjects with Unity Relay/Lobby for matchmaking — no custom server required.

> **Status:** working foundation. The code, systems, and Android build pipeline are wired up. You will need to open the project in Unity Editor to author scenes and prefabs (steps below) — Unity stores scene/prefab data as binary YAML that must be created in-editor — and to import 3D art assets you want to use.

## Tech stack

| Concern        | Tech |
| -------------- | ---- |
| Engine         | Unity 2022.3 LTS (URP) |
| Language       | C# |
| Networking     | Unity Netcode for GameObjects 1.8 |
| Transport      | Unity Transport (UTP) over Relay |
| Matchmaking    | Unity Lobby + Relay (UGS) |
| Persistence    | PlayerPrefs + UGS Cloud Save |
| Auth           | Unity Authentication (anonymous) |
| Target         | Android (IL2CPP, ARM64) |

## Folder layout

```
Assets/
  Scripts/
    Player/        PlayerController, PlayerHealth
    Weapons/       WeaponDefinition (SO), Weapon (NetworkBehaviour)
    Networking/    UgsBootstrap, MatchmakingService, MatchManager
    Skins/         SkinDefinition (SO), SkinDatabase, PlayerSkin
    Progression/   PlayerProfile, ProfileService (PlayerPrefs + Cloud Save)
    UI/            MainMenu, HUD, Scoreboard, SkinPicker
    Input/         VirtualJoystick, TouchLookArea, MobileInputBridge
    Arena/         ArenaBuilder (procedural primitives)
    Game/          GameBootstrap, ArenaSpawner, SceneFlow
  Scenes/          MainMenu.unity, Arena.unity   (you create these)
  Prefabs/         Player.prefab                  (you create this)
  Resources/Skins/ Skin .asset files              (you create these)
ProjectSettings/   Unity project configuration
Packages/manifest.json   UPM dependencies
```

## First-time setup

### 1. Install Unity

Install **Unity 2022.3.40f1** (LTS) via Unity Hub, with the **Android Build Support** module (includes OpenJDK and Android SDK/NDK).

### 2. Open the project

`Unity Hub → Open → select this repo's root folder.` Unity will resolve the packages from `Packages/manifest.json` (Netcode, Lobby, Relay, Auth, Cloud Save, URP, TextMeshPro). First open takes a few minutes.

When prompted to import TMP Essentials, accept.

### 3. Set up Unity Gaming Services

Matchmaking + cloud save require a UGS project.

1. `Edit → Project Settings → Services → Create / Link Project` and link to a UGS project on your Unity dashboard.
2. In the dashboard, enable: **Authentication**, **Lobby**, **Relay**, **Cloud Save**.
3. (Anonymous sign-in is on by default; nothing else to configure.)

### 4. Create the scenes

Create two scenes under `Assets/Scenes/`:

#### `MainMenu.unity`
- Add an empty GameObject `Menu` with a `Canvas` child (Screen Space – Overlay).
- Inside the canvas, build the menu UI with these elements and wire them to `MainMenuController`:
  - `TMP_InputField nameField`
  - `Button quickPlayButton`
  - `Button hostButton`
  - `Button skinsButton`
  - `TMP_Text statusText`
  - `TMP_Text levelText`
  - `Panel skinsPanel` containing a `ScrollRect` whose `Content` is wired to `SkinPickerController.content`, a `buttonPrefab` of type `Button` (with a child TMP_Text label), and a `TMP_Text equippedText`.
- Add an empty GameObject `NetworkManager` with the `NetworkManager` component (drag the **Unity Transport** as the network transport). Add a `MatchmakingService` component (auto-spawned at runtime, but having it here is fine for inspector debugging).

#### `Arena.unity`
- Create empty GameObject `Arena` with the `ArenaBuilder` component. Assign three URP/Lit materials to `floorMaterial`, `wallMaterial`, `crateMaterial`.
- Place 6–8 empty GameObjects tagged `Spawn` around the arena and pass them to `MatchManager.spawnPoints`.
- Create empty GameObject `MatchManager` with the `MatchManager` and `NetworkObject` components. Drag the spawn-point transforms into its `spawnPoints` array.
- Create empty GameObject `ArenaSpawner` with the `ArenaSpawner` and `NetworkObject` components, and drag the Player prefab (next step) into `playerPrefab`.
- Add a `Canvas` for the in-match HUD wired to `HUDController` (joystick, look-area, fire button, jump button, reload button, health slider, ammo TMP_Text, kill-feed TMP_Text).
- Also add a `Canvas` panel wired to `ScoreboardController` (toggled by a button you add).

### 5. Create the Player prefab

`Assets/Prefabs/Player.prefab` should contain:

- Root GameObject with:
  - `CharacterController`
  - `NetworkObject`
  - `NetworkTransform` (Unity.Netcode.Components)
  - `PlayerController` — assign the camera-pivot child and first/third-person rig children.
  - `PlayerHealth`
  - `PlayerSkin` — assign the body and weapon `Renderer`s.
- Child `CameraPivot` (used as the eye/camera anchor).
- Child `FirstPersonRig` containing the visible weapon mesh and a `Weapon` component (assign a `WeaponDefinition` asset and a `Muzzle` empty transform).
- Child `ThirdPersonRig` containing the visible body mesh.

Register the Player prefab in `NetworkManager → Network Prefabs`.

### 6. Author content

- **Weapon definitions:** `Assets → Create → FPS → Weapon Definition`. Create at minimum a `Rifle` asset and assign it to the `Weapon` component.
- **Skin definitions:** `Assets → Create → FPS → Skin Definition`. Place under `Assets/Resources/Skins/` so `SkinDatabase` picks them up. Set `skinId`, `displayName`, `unlockLevel`, materials, and an icon.

### 7. Configure Android build

`File → Build Settings`:

- Platform: **Android** → **Switch Platform**.
- Add `MainMenu` and `Arena` to *Scenes In Build* (MainMenu first).
- `Player Settings`:
  - Other Settings → Scripting Backend: **IL2CPP**, Target Architectures: **ARM64**.
  - Other Settings → Minimum API Level: 24, Target API Level: highest installed.
  - Other Settings → Package Name: `com.yourcompany.fpsmobile`.
  - Resolution & Presentation → Default Orientation: **Landscape Left**.
- Build → produces `fpsmobile.apk`.

### 8. Run

- One device builds + runs as **Host** (tap *Host*).
- Other devices on any network tap *Quick Play* — they will discover the public lobby via Unity Lobby and join through Relay.

## Architecture notes

- **Server-authoritative damage.** Clients raycast locally for responsiveness but call `ApplyDamageServerRpc` on the victim's `PlayerHealth`; the server is the only writer of the `Health` NetworkVariable and respawn position.
- **Lobby + Relay only.** No custom backend. The host allocates a Relay server, writes the join code into the public Lobby, and clients query → join. `MatchmakingService.QuickJoinAsync` falls back to hosting if no lobby has open slots.
- **Skins are owner-written.** `PlayerSkin.EquippedSkinId` is a NetworkVariable with `WritePermission.Owner` so the local client picks its skin. Materials are looked up from `Resources/Skins/` on every client.
- **Progression is local + cloud.** `ProfileService` saves to PlayerPrefs every kill, mirrors to UGS Cloud Save when authenticated. Levels gate skin unlocks via `SkinDefinition.unlockLevel`.

## Roadmap (next steps for production)

1. Replace primitive arena with a built level (greybox in ProBuilder, then art pass).
2. Replace placeholder body/weapon meshes with skinned characters and animated rigs.
3. Add per-weapon variety (SMG, sniper, shotgun) — the system already supports it via `WeaponDefinition`.
4. Add server-side anti-cheat: validate fire rate, line-of-sight, and damage on the server before applying.
5. Replace anonymous auth with real accounts (Google Play Games, Sign in with Apple).
6. Sign the APK and ship to Google Play (`File → Build Settings → Player Settings → Publishing Settings`).

## License

MIT — see `LICENSE`.
