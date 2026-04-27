using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.Core;
using UnityEngine;

namespace Game.Networking
{
    /// <summary>
    /// Initialises Unity Gaming Services and signs in anonymously so Lobby/Relay/Cloud
    /// Save are usable without a custom backend.
    /// </summary>
    public static class UgsBootstrap
    {
        public static bool Ready { get; private set; }

        public static async Task InitializeAsync()
        {
            if (Ready) return;
            try
            {
                await UnityServices.InitializeAsync();
                if (!AuthenticationService.Instance.IsSignedIn)
                {
                    await AuthenticationService.Instance.SignInAnonymouslyAsync();
                }
                Ready = true;
                Debug.Log($"UGS ready. PlayerId={AuthenticationService.Instance.PlayerId}");
            }
            catch (System.Exception e)
            {
                Debug.LogError($"UGS init failed: {e}");
            }
        }
    }
}
