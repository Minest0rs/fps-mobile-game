using System.Collections.Generic;
using UnityEngine;

namespace Game.Skins
{
    /// <summary>
    /// Resources-loaded catalogue of <see cref="SkinDefinition"/> assets, keyed by skinId.
    /// Place skin assets under Assets/Resources/Skins/.
    /// </summary>
    public static class SkinDatabase
    {
        private static Dictionary<string, SkinDefinition> _byId;

        public static IReadOnlyDictionary<string, SkinDefinition> All
        {
            get
            {
                EnsureLoaded();
                return _byId;
            }
        }

        public static SkinDefinition Get(string id)
        {
            EnsureLoaded();
            return _byId.TryGetValue(id ?? string.Empty, out var s) ? s : null;
        }

        private static void EnsureLoaded()
        {
            if (_byId != null) return;
            _byId = new Dictionary<string, SkinDefinition>();
            foreach (var s in Resources.LoadAll<SkinDefinition>("Skins"))
            {
                if (s == null || string.IsNullOrEmpty(s.skinId)) continue;
                _byId[s.skinId] = s;
            }
        }
    }
}
