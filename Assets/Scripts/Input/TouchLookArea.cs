using UnityEngine;
using UnityEngine.EventSystems;

namespace Game.Input
{
    /// <summary>
    /// Captures drag delta on the right side of the screen for camera look. Output is
    /// already scaled by sensitivity and exposed as a Vector2 delta consumed each frame.
    /// </summary>
    public class TouchLookArea : MonoBehaviour, IDragHandler, IPointerDownHandler, IPointerUpHandler
    {
        [SerializeField] private float sensitivity = 0.15f;

        private Vector2 _delta;
        private int _pointerId = -1;

        public Vector2 ConsumeDelta()
        {
            var d = _delta;
            _delta = Vector2.zero;
            return d;
        }

        public void OnPointerDown(PointerEventData eventData)
        {
            if (_pointerId != -1) return;
            _pointerId = eventData.pointerId;
        }

        public void OnPointerUp(PointerEventData eventData)
        {
            if (eventData.pointerId == _pointerId) _pointerId = -1;
        }

        public void OnDrag(PointerEventData eventData)
        {
            if (eventData.pointerId != _pointerId) return;
            _delta += eventData.delta * sensitivity;
        }
    }
}
