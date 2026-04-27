using System;
using UnityEngine;
using UnityEngine.EventSystems;

namespace Game.UI
{
    /// <summary>
    /// Helper that fires <see cref="OnPressChanged"/> when a UI element is pressed or
    /// released. Used by the fire button so the player keeps shooting while holding it.
    /// </summary>
    public class PressHoldButton : MonoBehaviour, IPointerDownHandler, IPointerUpHandler
    {
        public event Action<bool> OnPressChanged;

        public void OnPointerDown(PointerEventData eventData) => OnPressChanged?.Invoke(true);
        public void OnPointerUp(PointerEventData eventData) => OnPressChanged?.Invoke(false);
    }
}
