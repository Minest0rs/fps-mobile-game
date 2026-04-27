using UnityEngine;
using UnityEngine.EventSystems;

namespace Game.Input
{
    /// <summary>
    /// Lightweight on-screen joystick. Drag inside the assigned RectTransform to read a
    /// normalised 2D direction. Designed to be referenced by <see cref="PlayerController"/>.
    /// </summary>
    public class VirtualJoystick : MonoBehaviour, IDragHandler, IPointerDownHandler, IPointerUpHandler
    {
        [SerializeField] private RectTransform background;
        [SerializeField] private RectTransform handle;
        [SerializeField] private float handleRange = 80f;

        private Vector2 _input;

        public Vector2 Value => _input;

        public void OnPointerDown(PointerEventData eventData) => OnDrag(eventData);

        public void OnPointerUp(PointerEventData eventData)
        {
            _input = Vector2.zero;
            handle.anchoredPosition = Vector2.zero;
        }

        public void OnDrag(PointerEventData eventData)
        {
            if (!RectTransformUtility.ScreenPointToLocalPointInRectangle(
                    background, eventData.position, eventData.pressEventCamera, out var local))
            {
                return;
            }

            local /= background.sizeDelta * 0.5f;
            _input = local.magnitude > 1f ? local.normalized : local;
            handle.anchoredPosition = _input * handleRange;
        }
    }
}
