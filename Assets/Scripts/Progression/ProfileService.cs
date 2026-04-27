using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Unity.Services.CloudSave;
using UnityEngine;

namespace Game.Progression
{
    /// <summary>
    /// Load/save the local <see cref="PlayerProfile"/>. Mirrors to UGS Cloud Save when
    /// authentication is available; falls back to PlayerPrefs otherwise.
    /// </summary>
    public static class ProfileService
    {
        private const string PrefsKey = "fps_profile_v1";
        private const string CloudKey = "profile";

        public static PlayerProfile Current { get; private set; } = new();

        public static event Action ProfileChanged;

        public static void Load()
        {
            var json = PlayerPrefs.GetString(PrefsKey, string.Empty);
            if (!string.IsNullOrEmpty(json))
            {
                try
                {
                    Current = JsonUtility.FromJson<PlayerProfile>(json) ?? new PlayerProfile();
                }
                catch
                {
                    Current = new PlayerProfile();
                }
            }
            ProfileChanged?.Invoke();
        }

        public static void SaveLocal()
        {
            PlayerPrefs.SetString(PrefsKey, JsonUtility.ToJson(Current));
            PlayerPrefs.Save();
            ProfileChanged?.Invoke();
        }

        public static async Task LoadCloudAsync()
        {
            try
            {
                var keys = new HashSet<string> { CloudKey };
                var result = await CloudSaveService.Instance.Data.LoadAsync(keys);
                if (result.TryGetValue(CloudKey, out var raw))
                {
                    Current = JsonUtility.FromJson<PlayerProfile>(raw) ?? Current;
                    ProfileChanged?.Invoke();
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Cloud load failed: {e.Message}");
            }
        }

        public static async Task SaveCloudAsync()
        {
            SaveLocal();
            try
            {
                var data = new Dictionary<string, object> { { CloudKey, JsonUtility.ToJson(Current) } };
                await CloudSaveService.Instance.Data.ForceSaveAsync(data);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Cloud save failed: {e.Message}");
            }
        }

        public static void RegisterKill()
        {
            Current.AddXp(PlayerProfile.XpPerKill, out _);
            SaveLocal();
        }
    }
}
