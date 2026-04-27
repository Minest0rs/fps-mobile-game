using Game.GameRoot;
using Game.Networking;
using Game.Progression;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Game.UI
{
    /// <summary>
    /// Main menu wiring: Quick Play / Host / Settings / Skins / Profile. Loads the
    /// "Arena" scene once a Lobby+Relay handshake completes.
    /// </summary>
    public class MainMenuController : MonoBehaviour
    {
        [SerializeField] private Button quickPlayButton;
        [SerializeField] private Button hostButton;
        [SerializeField] private Button skinsButton;
        [SerializeField] private TMP_InputField nameField;
        [SerializeField] private TMP_Text statusText;
        [SerializeField] private TMP_Text levelText;
        [SerializeField] private GameObject skinsPanel;

        private async void Start()
        {
            ProfileService.Load();
            if (nameField != null) nameField.text = ProfileService.Current.playerName;

            UpdateLevel();
            ProfileService.ProfileChanged += UpdateLevel;

            quickPlayButton.onClick.AddListener(OnQuickPlay);
            hostButton.onClick.AddListener(OnHost);
            if (skinsButton != null && skinsPanel != null)
            {
                skinsButton.onClick.AddListener(() => skinsPanel.SetActive(!skinsPanel.activeSelf));
            }

            if (MatchmakingService.Instance != null)
            {
                MatchmakingService.Instance.OnStatusChanged += s => { if (statusText != null) statusText.text = s; };
            }

            await UgsBootstrap.InitializeAsync();
            await ProfileService.LoadCloudAsync();
            UpdateLevel();
        }

        private void OnDestroy()
        {
            ProfileService.ProfileChanged -= UpdateLevel;
        }

        private void UpdateLevel()
        {
            if (levelText == null) return;
            var p = ProfileService.Current;
            var next = PlayerProfile.XpToReach(p.level + 1);
            levelText.text = $"Lv {p.level}    XP {p.xp}/{next}";
        }

        public void OnNameChanged(string n)
        {
            ProfileService.Current.playerName = string.IsNullOrEmpty(n) ? "Player" : n;
            ProfileService.SaveLocal();
        }

        private async void OnQuickPlay()
        {
            ApplyName();
            await MatchmakingService.Instance.QuickJoinAsync();
            // Clients follow the host into the Arena scene via Netcode's scene manager.
        }

        private async void OnHost()
        {
            ApplyName();
            await MatchmakingService.Instance.HostMatchAsync($"{ProfileService.Current.playerName}'s match");
            SceneFlow.HostLoadArena();
        }

        private void ApplyName()
        {
            if (nameField != null) OnNameChanged(nameField.text);
        }
    }
}
