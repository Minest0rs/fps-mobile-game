using Game.Input;
using Game.Networking;
using Game.Player;
using Game.Weapons;
using TMPro;
using Unity.Netcode;
using UnityEngine;
using UnityEngine.UI;

namespace Game.UI
{
    /// <summary>
    /// In-match HUD: HP bar, ammo readout, kill feed, fire/jump/reload buttons. Wires
    /// the on-screen widgets to <see cref="MobileInputBridge"/>.
    /// </summary>
    public class HUDController : MonoBehaviour
    {
        [SerializeField] private VirtualJoystick moveStick;
        [SerializeField] private TouchLookArea lookArea;
        [SerializeField] private Button fireButton;
        [SerializeField] private Button jumpButton;
        [SerializeField] private Button reloadButton;
        [SerializeField] private Slider healthBar;
        [SerializeField] private TMP_Text ammoText;
        [SerializeField] private TMP_Text killFeedText;

        private void Start()
        {
            if (MobileInputBridge.Instance != null)
            {
                MobileInputBridge.Instance.Bind(moveStick, lookArea);
            }

            if (fireButton != null)
            {
                var trigger = fireButton.gameObject.AddComponent<UI.PressHoldButton>();
                trigger.OnPressChanged += held => MobileInputBridge.Instance.FireHeld = held;
            }
            if (jumpButton != null) jumpButton.onClick.AddListener(() => MobileInputBridge.Instance.JumpRequested = true);
            if (reloadButton != null) reloadButton.onClick.AddListener(() => MobileInputBridge.Instance.ReloadRequested = true);
        }

        private void Update()
        {
            var local = NetworkManager.Singleton != null && NetworkManager.Singleton.IsClient
                ? NetworkManager.Singleton.LocalClient?.PlayerObject
                : null;
            if (local == null) return;

            if (local.TryGetComponent<PlayerHealth>(out var hp) && healthBar != null)
            {
                healthBar.value = (float)hp.Health.Value / PlayerHealth.MaxHealth;
            }

            var weapon = local.GetComponentInChildren<Weapon>();
            if (weapon != null && ammoText != null)
            {
                ammoText.text = weapon.Definition != null
                    ? $"{weapon.CurrentMagazine}/{weapon.Definition.magazineSize}"
                    : "--/--";
            }

            UpdateKillFeed();
        }

        private void UpdateKillFeed()
        {
            if (MatchManager.Instance == null || killFeedText == null) return;
            var sb = new System.Text.StringBuilder();
            foreach (var k in MatchManager.Instance.KillFeed)
            {
                sb.AppendLine($"#{k.attacker} → #{k.victim}");
            }
            killFeedText.text = sb.ToString();
        }
    }
}
