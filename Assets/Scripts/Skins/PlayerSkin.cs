using Unity.Collections;
using Unity.Netcode;
using UnityEngine;

namespace Game.Skins
{
    /// <summary>
    /// Networked skin selection on a player. The owner sets <see cref="EquippedSkinId"/>,
    /// which is replicated through a NetworkVariable so every client applies the same
    /// materials to the visible body and weapon.
    /// </summary>
    public class PlayerSkin : NetworkBehaviour
    {
        public NetworkVariable<FixedString32Bytes> EquippedSkinId = new(
            new FixedString32Bytes("default"),
            NetworkVariableReadPermission.Everyone, NetworkVariableWritePermission.Owner);

        [SerializeField] private Renderer bodyRenderer;
        [SerializeField] private Renderer weaponRenderer;

        public override void OnNetworkSpawn()
        {
            EquippedSkinId.OnValueChanged += OnSkinChanged;
            Apply(EquippedSkinId.Value.ToString());
        }

        public override void OnNetworkDespawn()
        {
            EquippedSkinId.OnValueChanged -= OnSkinChanged;
        }

        private void OnSkinChanged(FixedString32Bytes _, FixedString32Bytes next)
            => Apply(next.ToString());

        private void Apply(string id)
        {
            var def = SkinDatabase.Get(id);
            if (def == null) return;
            if (bodyRenderer != null && def.bodyMaterial != null) bodyRenderer.sharedMaterial = def.bodyMaterial;
            if (weaponRenderer != null && def.weaponMaterial != null) weaponRenderer.sharedMaterial = def.weaponMaterial;
        }

        public void EquipFromOwner(string id)
        {
            if (!IsOwner) return;
            EquippedSkinId.Value = new FixedString32Bytes(id);
        }
    }
}
