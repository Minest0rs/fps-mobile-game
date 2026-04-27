using Game.Networking;
using Game.Progression;
using Game.Skins;
using Unity.Collections;
using Unity.Netcode;
using UnityEngine;

namespace Game.GameRoot
{
    /// <summary>
    /// Lives in the Arena scene. The server spawns a player object for every connected
    /// client, sets initial position, applies the requested skin and display name, and
    /// hooks the player into <see cref="MatchManager"/>.
    /// </summary>
    public class ArenaSpawner : NetworkBehaviour
    {
        [SerializeField] private NetworkObject playerPrefab;

        public override void OnNetworkSpawn()
        {
            if (!IsServer) return;

            NetworkManager.Singleton.OnClientConnectedCallback += SpawnFor;
            foreach (var id in NetworkManager.Singleton.ConnectedClientsIds) SpawnFor(id);
        }

        public override void OnNetworkDespawn()
        {
            if (NetworkManager.Singleton != null)
            {
                NetworkManager.Singleton.OnClientConnectedCallback -= SpawnFor;
            }
        }

        private void SpawnFor(ulong clientId)
        {
            if (!IsServer || playerPrefab == null) return;

            var spawn = MatchManager.Instance != null ? MatchManager.Instance.GetSpawnPoint() : Vector3.zero;
            var instance = Instantiate(playerPrefab, spawn, Quaternion.identity);
            instance.SpawnAsPlayerObject(clientId, true);

            if (instance.TryGetComponent<Game.Player.PlayerHealth>(out var hp))
            {
                hp.DisplayName.Value = new FixedString64Bytes($"#{clientId}");
            }

            // Defer skin assignment to the owning client; server only sets a sane default.
            if (instance.TryGetComponent<PlayerSkin>(out var skin))
            {
                skin.EquippedSkinId.Value = new FixedString32Bytes("default");
            }
        }
    }
}
