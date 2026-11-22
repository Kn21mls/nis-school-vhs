import { Box3, BufferGeometry, Group, Vector3 } from 'three';

// The packed scene merges objects by material. Recover separate parts by
// joining triangles at equal positions, including across normal seams.
function splitParts(mesh) {
  const geometry = mesh.geometry;
  const positions = geometry.attributes.position;
  const index = geometry.index;
  const parent = new Map();
  const keys = Array.from({ length: positions.count }, (_, i) =>
    [positions.getX(i), positions.getY(i), positions.getZ(i)].join(','));
  function root(key) {
    while (parent.has(key)) key = parent.get(key);
    return key;
  }
  for (let i = 0; i < index.count; i += 3) {
    const first = root(keys[index.getX(i)]);
    for (const offset of [1, 2]) {
      const other = root(keys[index.getX(i + offset)]);
      if (other !== first) parent.set(other, first);
    }
  }
  const indices = new Map();
  for (let i = 0; i < index.count; i += 3) {
    const key = root(keys[index.getX(i)]);
    if (!indices.has(key)) indices.set(key, []);
    indices.get(key).push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  }
  return Array.from(indices.values(), triangles => {
    const bounds = new Box3();
    const points = Array.from(new Set(triangles), i =>
      new Vector3().fromBufferAttribute(positions, i));
    bounds.setFromPoints(points);
    return { mesh, triangles, points, bounds };
  });
}

export function installDoors(model) {
  model.updateMatrixWorld(true);
  const sources = [];
  model.traverse(mesh => {
    if (mesh.isMesh && mesh.geometry.index &&
        ['door_oak', 'door_glass'].includes(mesh.material.name)) sources.push(mesh);
  });
  const parts = sources.flatMap(splitParts);
  const doors = new Map();
  const leaves = [];
  for (const part of parts) {
    if (part.mesh.material.name !== 'door_oak') continue;
    const height = part.bounds.clone().applyMatrix4(part.mesh.matrixWorld).getSize(new Vector3()).y;
    // NIS_v09 leaf panels are 2.05 m tall. The surrounding frames are taller.
    if (Math.abs(height - 2.05) > 0.02) continue;
    const [a, b] = part.points.reduce(([left, right], point) =>
      [point.x < left.x ? point : left, point.x > right.x ? point : right],
    [part.points[0], part.points[0]]);
    const axis = part.bounds.getSize(new Vector3());
    const pivot = axis.x >= axis.z ? a : part.points.reduce((end, point) =>
      point.z < end.z ? point : end, b);
    const hinge = new Group();
    part.mesh.add(hinge);
    hinge.position.copy(pivot);
    leaves.push({ part, hinge });
  }
  for (const part of parts) {
    const leaf = leaves.find(({ part: panel }) => panel === part ||
      (part.mesh.material.name === 'door_glass' &&
        panel.mesh.matrixWorld.equals(part.mesh.matrixWorld) &&
        panel.bounds.clone().expandByScalar(2).containsBox(part.bounds)));
    if (!leaf) continue;
    const mesh = part.mesh.clone(false);
    mesh.position.copy(leaf.hinge.position).negate();
    mesh.quaternion.identity();
    mesh.scale.setScalar(1);
    mesh.geometry = new BufferGeometry();
    for (const [name, attribute] of Object.entries(part.mesh.geometry.attributes)) {
      mesh.geometry.setAttribute(name, attribute);
    }
    mesh.geometry.setIndex(part.triangles);
    leaf.hinge.add(mesh);
    doors.set(mesh, leaf.hinge);
    part.moved = true;
  }
  for (const mesh of sources) {
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.setIndex(parts.filter(part => part.mesh === mesh && !part.moved)
      .flatMap(part => part.triangles));
  }
  model.updateMatrixWorld(true);
  return doors;
}
