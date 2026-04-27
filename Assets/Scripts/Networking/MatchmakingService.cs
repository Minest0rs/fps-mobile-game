using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Unity.Netcode;
using Unity.Netcode.Transports.UTP;
using Unity.Networking.Transport.Relay;
using Unity.Services.Authentication;
using Unity.Services.Lobbies;
using Unity.Services.Lobbies.Models;
using Unity.Services.Relay;
using Unity.Services.Relay.Models;
using UnityEngine;

namespace Game.Networking
{
    /// <summary>
    /// Public-lobby matchmaking on top of Unity Lobby + Relay. The host allocates a
    /// Relay server and writes the join code into a public Lobby; clients query the
    /// Lobby service, pick the freshest game and join via Relay.
    /// </summary>
    public class MatchmakingService : MonoBehaviour
    {
        public static MatchmakingService Instance { get; private set; }

        public const int MaxPlayers = 8;
        private const string RelayJoinCodeKey = "RELAY_CODE";

        public Lobby CurrentLobby { get; private set; }
        public bool IsHost { get; private set; }
        private float _heartbeatTimer;

        public event Action<string> OnStatusChanged;

        private void Awake()
        {
            if (Instance != null && Instance != this) Destroy(gameObject);
            else { Instance = this; DontDestroyOnLoad(gameObject); }
        }

        private void Update()
        {
            if (!IsHost || CurrentLobby == null) return;
            _heartbeatTimer -= Time.unscaledDeltaTime;
            if (_heartbeatTimer > 0f) return;
            _heartbeatTimer = 15f;
            _ = LobbyService.Instance.SendHeartbeatPingAsync(CurrentLobby.Id);
        }

        public async Task HostMatchAsync(string lobbyName)
        {
            await UgsBootstrap.InitializeAsync();
            OnStatusChanged?.Invoke("Allocating relay…");

            Allocation allocation = await RelayService.Instance.CreateAllocationAsync(MaxPlayers - 1);
            string joinCode = await RelayService.Instance.GetJoinCodeAsync(allocation.AllocationId);

            var transport = NetworkManager.Singleton.GetComponent<UnityTransport>();
            transport.SetRelayServerData(new RelayServerData(allocation, "dtls"));

            OnStatusChanged?.Invoke("Creating lobby…");
            var options = new CreateLobbyOptions
            {
                IsPrivate = false,
                Player = MakePlayer(),
                Data = new Dictionary<string, DataObject>
                {
                    { RelayJoinCodeKey, new DataObject(DataObject.VisibilityOptions.Member, joinCode) }
                }
            };
            CurrentLobby = await LobbyService.Instance.CreateLobbyAsync(lobbyName, MaxPlayers, options);
            IsHost = true;

            NetworkManager.Singleton.StartHost();
            OnStatusChanged?.Invoke("Hosting");
        }

        public async Task QuickJoinAsync()
        {
            await UgsBootstrap.InitializeAsync();
            OnStatusChanged?.Invoke("Searching…");

            var query = new QueryLobbiesOptions
            {
                Count = 25,
                Filters = new List<QueryFilter>
                {
                    new(QueryFilter.FieldOptions.AvailableSlots, "0", QueryFilter.OpOptions.GT)
                },
                Order = new List<QueryOrder>
                {
                    new(false, QueryOrder.FieldOptions.Created)
                }
            };
            var resp = await LobbyService.Instance.QueryLobbiesAsync(query);
            if (resp.Results.Count == 0)
            {
                OnStatusChanged?.Invoke("No matches found, hosting…");
                await HostMatchAsync($"{ProfileNameOrFallback()}'s match");
                return;
            }

            await JoinLobbyAsync(resp.Results[0].Id);
        }

        public async Task JoinLobbyAsync(string lobbyId)
        {
            await UgsBootstrap.InitializeAsync();
            OnStatusChanged?.Invoke("Joining lobby…");

            CurrentLobby = await LobbyService.Instance.JoinLobbyByIdAsync(lobbyId,
                new JoinLobbyByIdOptions { Player = MakePlayer() });

            var joinCode = CurrentLobby.Data[RelayJoinCodeKey].Value;
            JoinAllocation join = await RelayService.Instance.JoinAllocationAsync(joinCode);

            var transport = NetworkManager.Singleton.GetComponent<UnityTransport>();
            transport.SetRelayServerData(new RelayServerData(join, "dtls"));

            NetworkManager.Singleton.StartClient();
            IsHost = false;
            OnStatusChanged?.Invoke("Connected");
        }

        public async Task LeaveAsync()
        {
            try
            {
                if (CurrentLobby == null) return;
                if (IsHost) await LobbyService.Instance.DeleteLobbyAsync(CurrentLobby.Id);
                else await LobbyService.Instance.RemovePlayerAsync(CurrentLobby.Id, AuthenticationService.Instance.PlayerId);
            }
            catch (Exception e) { Debug.LogWarning(e); }
            finally
            {
                CurrentLobby = null;
                IsHost = false;
                if (NetworkManager.Singleton != null && NetworkManager.Singleton.IsListening)
                {
                    NetworkManager.Singleton.Shutdown();
                }
                OnStatusChanged?.Invoke("Disconnected");
            }
        }

        private static Player MakePlayer()
        {
            return new Player(AuthenticationService.Instance.PlayerId,
                data: new Dictionary<string, PlayerDataObject>
                {
                    { "name", new PlayerDataObject(PlayerDataObject.VisibilityOptions.Member, ProfileNameOrFallback()) }
                });
        }

        private static string ProfileNameOrFallback()
        {
            var n = Game.Progression.ProfileService.Current?.playerName;
            return string.IsNullOrEmpty(n) ? "Player" : n;
        }
    }
}
