using System;
using Unity.Collections;
using Unity.Netcode;
using UnityEngine;

namespace Game.Player
{
    /// <summary>
    /// Server-authoritative player health and respawn. Damage is applied via ServerRpc
    /// and current HP is broadcast through a NetworkVariable so HUDs and scoreboards
    /// can subscribe without polling.
    /// </summary>
    public class PlayerHealth : NetworkBehaviour
    {
        public const int MaxHealth = 100;

        public NetworkVariable<int> Health = new(MaxHealth,
            NetworkVariableReadPermission.Everyone, NetworkVariableWritePermission.Server);

        public NetworkVariable<FixedString64Bytes> DisplayName = new("Player",
            NetworkVariableReadPermission.Everyone, NetworkVariableWritePermission.Server);

        public event Action<ulong, ulong> OnPlayerKilled; // killerId, victimId

        [SerializeField] private float respawnDelay = 3f;

        public bool IsDead => Health.Value <= 0;

        public override void OnNetworkSpawn()
        {
            if (IsServer) Health.Value = MaxHealth;
        }

        [ServerRpc(RequireOwnership = false)]
        public void ApplyDamageServerRpc(int damage, ulong attackerId)
        {
            if (IsDead) return;

            Health.Value = Mathf.Max(0, Health.Value - damage);
            if (Health.Value > 0) return;

            OnPlayerKilled?.Invoke(attackerId, OwnerClientId);
            Networking.MatchManager.Instance?.RegisterKill(attackerId, OwnerClientId);
            Invoke(nameof(Respawn), respawnDelay);
        }

        private void Respawn()
        {
            if (!IsServer) return;
            var spawn = Networking.MatchManager.Instance != null
                ? Networking.MatchManager.Instance.GetSpawnPoint()
                : Vector3.zero;

            transform.position = spawn;
            Health.Value = MaxHealth;
        }
    }
}
