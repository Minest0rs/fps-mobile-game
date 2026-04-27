using System.Collections.Generic;
using System.Linq;
using Game.Networking;
using TMPro;
using Unity.Netcode;
using UnityEngine;

namespace Game.UI
{
    /// <summary>
    /// Reads kill/death counts from <see cref="MatchManager"/> on a 1-second cadence and
    /// renders the standings as plain text rows. Toggle via the Tab/scoreboard button.
    /// </summary>
    public class ScoreboardController : MonoBehaviour
    {
        [SerializeField] private TMP_Text rowsText;
        [SerializeField] private float refreshInterval = 1f;

        private float _timer;

        private void Update()
        {
            _timer -= Time.unscaledDeltaTime;
            if (_timer > 0f) return;
            _timer = refreshInterval;

            if (NetworkManager.Singleton == null || !NetworkManager.Singleton.IsClient) return;
            if (MatchManager.Instance == null) return;

            var rows = new List<string>();
            foreach (var c in NetworkManager.Singleton.ConnectedClientsIds.OrderBy(x => x))
            {
                var k = MatchManager.Instance.KillsOf(c);
                var d = MatchManager.Instance.DeathsOf(c);
                rows.Add($"#{c}    K {k}    D {d}");
            }
            rowsText.text = string.Join("\n", rows);
        }
    }
}
