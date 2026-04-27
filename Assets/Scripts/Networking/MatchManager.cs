using System.Collections.Generic;
using Unity.Netcode;
using UnityEngine;

namespace Game.Networking
{
    /// <summary>
    /// Server-only match state: kill counts, spawn points, kill feed. Clients receive
    /// updates via NetworkVariables and ClientRpc.
    /// </summary>
    public class MatchManager : NetworkBehaviour
    {
        public static MatchManager Instance { get; private set; }

        public NetworkList<KillEntry> KillFeed;

        [SerializeField] private Transform[] spawnPoints;
        private readonly Dictionary<ulong, int> _kills = new();
        private readonly Dictionary<ulong, int> _deaths = new();

        private void Awake()
        {
            Instance = this;
            KillFeed = new NetworkList<KillEntry>();
        }

        public Vector3 GetSpawnPoint()
        {
            if (spawnPoints == null || spawnPoints.Length == 0) return Vector3.zero;
            return spawnPoints[Random.Range(0, spawnPoints.Length)].position;
        }

        public int KillsOf(ulong id) => _kills.TryGetValue(id, out var k) ? k : 0;
        public int DeathsOf(ulong id) => _deaths.TryGetValue(id, out var d) ? d : 0;

        public void RegisterKill(ulong attackerId, ulong victimId)
        {
            if (!IsServer) return;
            _kills.TryGetValue(attackerId, out var k); _kills[attackerId] = k + 1;
            _deaths.TryGetValue(victimId, out var d); _deaths[victimId] = d + 1;
            if (KillFeed.Count >= 6) KillFeed.RemoveAt(0);
            KillFeed.Add(new KillEntry { attacker = attackerId, victim = victimId, time = Time.time });
            NotifyKillClientRpc(attackerId);
        }

        [ClientRpc]
        private void NotifyKillClientRpc(ulong attackerId)
        {
            if (NetworkManager.Singleton.LocalClientId == attackerId)
            {
                Game.Progression.ProfileService.RegisterKill();
            }
        }
    }

    public struct KillEntry : INetworkSerializable, System.IEquatable<KillEntry>
    {
        public ulong attacker;
        public ulong victim;
        public float time;

        public void NetworkSerialize<T>(BufferSerializer<T> serializer) where T : IReaderWriter
        {
            serializer.SerializeValue(ref attacker);
            serializer.SerializeValue(ref victim);
            serializer.SerializeValue(ref time);
        }

        public bool Equals(KillEntry other)
            => attacker == other.attacker && victim == other.victim && time.Equals(other.time);
    }
}
