using UnityEngine;

namespace Game.Input
{
    /// <summary>
    /// Single point of access for player input. Bound by <see cref="HUDController"/> to
    /// the on-screen widgets so gameplay scripts only depend on this interface.
    /// </summary>
    public class MobileInputBridge : MonoBehaviour
    {
        public static MobileInputBridge Instance { get; private set; }

        [SerializeField] private VirtualJoystick moveStick;
        [SerializeField] private TouchLookArea lookArea;
        public bool FireHeld { get; set; }
        public bool JumpRequested { get; set; }
        public bool ReloadRequested { get; set; }

        private void Awake()
        {
            if (Instance != null && Instance != this) Destroy(gameObject);
            else Instance = this;
        }

        public void Bind(VirtualJoystick stick, TouchLookArea look)
        {
            moveStick = stick;
            lookArea = look;
        }

        public Vector2 MoveAxis => moveStick != null ? moveStick.Value : Vector2.zero;
        public Vector2 LookDelta => lookArea != null ? lookArea.ConsumeDelta() : Vector2.zero;

        public bool ConsumeJump()
        {
            if (!JumpRequested) return false;
            JumpRequested = false;
            return true;
        }

        public bool ConsumeReload()
        {
            if (!ReloadRequested) return false;
            ReloadRequested = false;
            return true;
        }
    }
}
