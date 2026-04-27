using UnityEngine;

namespace Game.Weapons
{
    /// <summary>
    /// Static data for a weapon archetype. Authored as ScriptableObject assets so
    /// designers can tweak balance without code changes.
    /// </summary>
    [CreateAssetMenu(menuName = "FPS/Weapon Definition", fileName = "WeaponDef")]
    public class WeaponDefinition : ScriptableObject
    {
        public string displayName = "Rifle";
        public int damage = 22;
        public float range = 100f;
        [Tooltip("Shots per second.")] public float fireRate = 8f;
        public int magazineSize = 30;
        public float reloadSeconds = 2f;
        public float spreadDegrees = 1.2f;
        [Tooltip("Recoil applied to camera pitch per shot, in degrees.")]
        public float recoil = 1.4f;

        public AudioClip fireSfx;
        public GameObject muzzleFlashPrefab;
        public GameObject impactPrefab;
    }
}
