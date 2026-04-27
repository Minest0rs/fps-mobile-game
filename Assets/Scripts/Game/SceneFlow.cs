using Unity.Netcode;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Game.GameRoot
{
    /// <summary>
    /// Coordinates loading the Arena scene through Netcode's scene management so
    /// every client transitions in lockstep with the server.
    /// </summary>
    public static class SceneFlow
    {
        public const string MenuScene = "MainMenu";
        public const string ArenaScene = "Arena";

        public static void HostLoadArena()
        {
            if (NetworkManager.Singleton == null || !NetworkManager.Singleton.IsServer) return;
            NetworkManager.Singleton.SceneManager.LoadScene(ArenaScene, LoadSceneMode.Single);
        }
    }
}
