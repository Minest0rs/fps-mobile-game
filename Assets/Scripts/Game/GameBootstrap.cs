using Game.Input;
using Game.Networking;
using UnityEngine;

namespace Game.GameRoot
{
    /// <summary>
    /// Owns the singletons that must outlive scene loads. Spawned automatically before
    /// the first scene via <see cref="RuntimeInitializeOnLoadMethodAttribute"/>.
    /// </summary>
    public static class GameBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Init()
        {
            if (Object.FindObjectOfType<MatchmakingService>() == null)
            {
                var go = new GameObject("Matchmaking");
                Object.DontDestroyOnLoad(go);
                go.AddComponent<MatchmakingService>();
            }

            if (Object.FindObjectOfType<MobileInputBridge>() == null)
            {
                var go = new GameObject("InputBridge");
                Object.DontDestroyOnLoad(go);
                go.AddComponent<MobileInputBridge>();
            }
        }
    }
}
