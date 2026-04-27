using System;
using System.Collections.Generic;
using UnityEngine;

namespace Game.Progression
{
    /// <summary>
    /// Local profile: level, XP, and unlocked skins. Persists to PlayerPrefs and is
    /// pushed to UGS Cloud Save when the user is signed in.
    /// </summary>
    [Serializable]
    public class PlayerProfile
    {
        public string playerName = "Player";
        public int level = 1;
        public int xp = 0;
        public List<string> unlockedSkins = new() { "default" };
        public string equippedSkin = "default";

        public const int XpPerKill = 100;

        public static int XpToReach(int targetLevel)
            => Mathf.RoundToInt(100f * Mathf.Pow(targetLevel, 1.5f));

        public bool AddXp(int amount, out int levelsGained)
        {
            levelsGained = 0;
            xp += amount;
            while (xp >= XpToReach(level + 1))
            {
                level++;
                levelsGained++;
            }
            return levelsGained > 0;
        }
    }
}
