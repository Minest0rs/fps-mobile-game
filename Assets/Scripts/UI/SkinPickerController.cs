using Game.Progression;
using Game.Skins;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Game.UI
{
    /// <summary>
    /// Generates a button per skin in the database, locking ones above the player's
    /// current level. Persists the selection through <see cref="ProfileService"/>.
    /// </summary>
    public class SkinPickerController : MonoBehaviour
    {
        [SerializeField] private RectTransform content;
        [SerializeField] private Button buttonPrefab;
        [SerializeField] private TMP_Text equippedText;

        private void OnEnable() => Build();

        private void Build()
        {
            if (content == null || buttonPrefab == null) return;

            for (int i = content.childCount - 1; i >= 0; i--) Destroy(content.GetChild(i).gameObject);

            foreach (var kv in SkinDatabase.All)
            {
                var skin = kv.Value;
                var btn = Instantiate(buttonPrefab, content);
                var label = btn.GetComponentInChildren<TMP_Text>();
                bool unlocked = ProfileService.Current.level >= skin.unlockLevel;
                if (label != null)
                {
                    label.text = unlocked
                        ? skin.displayName
                        : $"{skin.displayName} (Lv {skin.unlockLevel})";
                }
                btn.interactable = unlocked;
                btn.onClick.AddListener(() =>
                {
                    if (!unlocked) return;
                    ProfileService.Current.equippedSkin = skin.skinId;
                    if (!ProfileService.Current.unlockedSkins.Contains(skin.skinId))
                    {
                        ProfileService.Current.unlockedSkins.Add(skin.skinId);
                    }
                    ProfileService.SaveLocal();
                    if (equippedText != null) equippedText.text = $"Equipped: {skin.displayName}";
                });
            }

            if (equippedText != null)
            {
                var def = SkinDatabase.Get(ProfileService.Current.equippedSkin);
                equippedText.text = def != null ? $"Equipped: {def.displayName}" : "Equipped: Default";
            }
        }
    }
}
