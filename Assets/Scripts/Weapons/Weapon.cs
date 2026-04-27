using Game.Input;
using Game.Player;
using Unity.Netcode;
using UnityEngine;

namespace Game.Weapons
{
    /// <summary>
    /// Per-player networked weapon. Uses hitscan via raycast on the firing client and
    /// validates damage on the server through <see cref="PlayerHealth"/>.
    /// </summary>
    public class Weapon : NetworkBehaviour
    {
        [SerializeField] private WeaponDefinition definition;
        [SerializeField] private Transform muzzle;

        private float _nextFireTime;
        private int _magazine;
        private bool _reloading;

        public int CurrentMagazine => _magazine;
        public WeaponDefinition Definition => definition;

        public void Configure(WeaponDefinition def)
        {
            definition = def;
            _magazine = def.magazineSize;
        }

        private void Update()
        {
            if (!IsOwner || definition == null) return;

            if (MobileInputBridge.Instance != null && MobileInputBridge.Instance.ConsumeReload())
            {
                BeginReload();
            }

            if (_reloading) return;

            if (MobileInputBridge.Instance != null && MobileInputBridge.Instance.FireHeld
                && Time.time >= _nextFireTime
                && _magazine > 0)
            {
                Fire();
            }
        }

        private void Fire()
        {
            _nextFireTime = Time.time + 1f / Mathf.Max(0.01f, definition.fireRate);
            _magazine--;

            var cam = GetComponentInParent<PlayerController>().OwnedCamera;
            if (cam == null) return;

            var spread = Quaternion.Euler(
                Random.Range(-definition.spreadDegrees, definition.spreadDegrees),
                Random.Range(-definition.spreadDegrees, definition.spreadDegrees),
                0f);
            var dir = spread * cam.transform.forward;

            ulong hitId = ulong.MaxValue;
            if (Physics.Raycast(cam.transform.position, dir, out var hit, definition.range))
            {
                var target = hit.collider.GetComponentInParent<PlayerHealth>();
                if (target != null && target.OwnerClientId != OwnerClientId)
                {
                    hitId = target.OwnerClientId;
                }
            }

            if (hitId != ulong.MaxValue)
            {
                ReportHitServerRpc(hitId, definition.damage);
            }

            FireFxServerRpc();
        }

        [ServerRpc]
        private void ReportHitServerRpc(ulong victimId, int damage)
        {
            var net = NetworkManager.Singleton;
            if (net == null) return;
            if (!net.ConnectedClients.TryGetValue(victimId, out var client)) return;
            if (client.PlayerObject == null) return;

            var hp = client.PlayerObject.GetComponent<PlayerHealth>();
            if (hp != null) hp.ApplyDamageServerRpc(damage, OwnerClientId);
        }

        [ServerRpc]
        private void FireFxServerRpc()
        {
            FireFxClientRpc();
        }

        [ClientRpc]
        private void FireFxClientRpc()
        {
            if (definition.muzzleFlashPrefab != null && muzzle != null)
            {
                Instantiate(definition.muzzleFlashPrefab, muzzle.position, muzzle.rotation);
            }
        }

        private void BeginReload()
        {
            if (_magazine == definition.magazineSize) return;
            _reloading = true;
            Invoke(nameof(FinishReload), definition.reloadSeconds);
        }

        private void FinishReload()
        {
            _magazine = definition.magazineSize;
            _reloading = false;
        }
    }
}
