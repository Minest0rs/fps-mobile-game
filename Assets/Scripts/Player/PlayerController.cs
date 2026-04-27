using Game.Input;
using Unity.Netcode;
using UnityEngine;

namespace Game.Player
{
    /// <summary>
    /// Server-authoritative FPS controller. The owning client samples mobile input,
    /// drives a CharacterController locally for responsiveness, and the transform is
    /// synced to other clients via NetworkTransform on the same GameObject.
    /// </summary>
    [RequireComponent(typeof(CharacterController))]
    public class PlayerController : NetworkBehaviour
    {
        [Header("Movement")]
        [SerializeField] private float walkSpeed = 5f;
        [SerializeField] private float sprintSpeed = 8f;
        [SerializeField] private float jumpHeight = 1.4f;
        [SerializeField] private float gravity = -20f;

        [Header("Look")]
        [SerializeField] private Transform cameraPivot;
        [SerializeField] private float pitchMin = -85f;
        [SerializeField] private float pitchMax = 85f;

        [Header("Refs")]
        [SerializeField] private GameObject firstPersonRig;
        [SerializeField] private GameObject thirdPersonRig;

        private CharacterController _cc;
        private Vector3 _velocity;
        private float _pitch;

        public Camera OwnedCamera { get; private set; }

        private void Awake() => _cc = GetComponent<CharacterController>();

        public override void OnNetworkSpawn()
        {
            base.OnNetworkSpawn();

            if (firstPersonRig != null) firstPersonRig.SetActive(IsOwner);
            if (thirdPersonRig != null) thirdPersonRig.SetActive(!IsOwner);

            if (IsOwner)
            {
                OwnedCamera = Camera.main;
                if (OwnedCamera != null && cameraPivot != null)
                {
                    OwnedCamera.transform.SetParent(cameraPivot, false);
                    OwnedCamera.transform.localPosition = Vector3.zero;
                    OwnedCamera.transform.localRotation = Quaternion.identity;
                }
            }
        }

        private void Update()
        {
            if (!IsOwner) return;

            HandleLook();
            HandleMovement();
        }

        private void HandleLook()
        {
            var look = MobileInputBridge.Instance != null
                ? MobileInputBridge.Instance.LookDelta
                : Vector2.zero;

            transform.Rotate(0f, look.x, 0f, Space.Self);
            _pitch = Mathf.Clamp(_pitch - look.y, pitchMin, pitchMax);
            if (cameraPivot != null)
            {
                cameraPivot.localRotation = Quaternion.Euler(_pitch, 0f, 0f);
            }
        }

        private void HandleMovement()
        {
            var axis = MobileInputBridge.Instance != null
                ? MobileInputBridge.Instance.MoveAxis
                : Vector2.zero;

            var speed = walkSpeed;
            var move = transform.right * axis.x + transform.forward * axis.y;
            move *= speed;

            if (_cc.isGrounded)
            {
                if (_velocity.y < 0f) _velocity.y = -2f;
                if (MobileInputBridge.Instance != null && MobileInputBridge.Instance.ConsumeJump())
                {
                    _velocity.y = Mathf.Sqrt(jumpHeight * -2f * gravity);
                }
            }

            _velocity.y += gravity * Time.deltaTime;

            var motion = move + new Vector3(0f, _velocity.y, 0f);
            _cc.Move(motion * Time.deltaTime);
        }
    }
}
