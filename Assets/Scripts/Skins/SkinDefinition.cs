using UnityEngine;

namespace Game.Skins
{
    /// <summary>
    /// Cosmetic-only skin. Holds materials applied to the character/weapon meshes.
    /// </summary>
    [CreateAssetMenu(menuName = "FPS/Skin Definition", fileName = "Skin")]
    public class SkinDefinition : ScriptableObject
    {
        public string skinId = "default";
        public string displayName = "Default";
        public int unlockLevel = 0;
        public Material bodyMaterial;
        public Material weaponMaterial;
        public Sprite icon;
    }
}
