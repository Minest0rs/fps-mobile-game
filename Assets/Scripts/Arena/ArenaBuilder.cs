using UnityEngine;

namespace Game.Arena
{
    /// <summary>
    /// Generates a simple symmetrical arena out of primitives so the project can run
    /// end-to-end before any 3D art is imported. Replace with a proper level later.
    /// </summary>
    public class ArenaBuilder : MonoBehaviour
    {
        [SerializeField] private Vector2 size = new(40f, 40f);
        [SerializeField] private int obstacleCount = 12;
        [SerializeField] private Material floorMaterial;
        [SerializeField] private Material wallMaterial;
        [SerializeField] private Material crateMaterial;

        private void Awake() => Build();

        private void Build()
        {
            // Floor
            var floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
            floor.name = "Floor";
            floor.transform.SetParent(transform);
            floor.transform.localScale = new Vector3(size.x / 10f, 1f, size.y / 10f);
            if (floorMaterial != null) floor.GetComponent<Renderer>().sharedMaterial = floorMaterial;

            // Walls
            CreateWall(new Vector3(0f, 1.5f, size.y * 0.5f), new Vector3(size.x, 3f, 1f));
            CreateWall(new Vector3(0f, 1.5f, -size.y * 0.5f), new Vector3(size.x, 3f, 1f));
            CreateWall(new Vector3(size.x * 0.5f, 1.5f, 0f), new Vector3(1f, 3f, size.y));
            CreateWall(new Vector3(-size.x * 0.5f, 1.5f, 0f), new Vector3(1f, 3f, size.y));

            // Random crates
            for (int i = 0; i < obstacleCount; i++)
            {
                var crate = GameObject.CreatePrimitive(PrimitiveType.Cube);
                crate.name = $"Crate_{i}";
                crate.transform.SetParent(transform);
                var s = Random.Range(1.4f, 2.4f);
                crate.transform.localScale = new Vector3(s, s, s);
                crate.transform.position = new Vector3(
                    Random.Range(-size.x * 0.45f, size.x * 0.45f),
                    s * 0.5f,
                    Random.Range(-size.y * 0.45f, size.y * 0.45f));
                if (crateMaterial != null) crate.GetComponent<Renderer>().sharedMaterial = crateMaterial;
            }
        }

        private void CreateWall(Vector3 center, Vector3 scale)
        {
            var wall = GameObject.CreatePrimitive(PrimitiveType.Cube);
            wall.name = "Wall";
            wall.transform.SetParent(transform);
            wall.transform.position = center;
            wall.transform.localScale = scale;
            if (wallMaterial != null) wall.GetComponent<Renderer>().sharedMaterial = wallMaterial;
        }
    }
}
