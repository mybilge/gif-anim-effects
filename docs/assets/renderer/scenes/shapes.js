import * as THREE from '../vendor/three-0.186.1/three.module.js';

export function create(renderer, { scale, tilt }, loop, shape, seed) {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 20);
  camera.position.z = shape === 'inside-sphere' ? 0 : 3.2;
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, side: shape === 'inside-sphere' ? THREE.BackSide : THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const group = new THREE.Group();
  const scene = new THREE.Scene().add(group);
  const geometries = [];
  function mesh(geometry, x = 0, y = 0, z = 0) {
    const normal = geometry.getAttribute('normal');
    const colors = [];
    for (let i = 0; i < normal.count; i++) {
      const brightness = shape === 'inside-sphere' ? 1 : 0.6 + 0.4 * Math.max(0, normal.getX(i) * 0.3 + normal.getY(i) * 0.4 + normal.getZ(i) * 0.86);
      colors.push(brightness, brightness, brightness);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometries.push(geometry);
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z);
    group.add(object);
    return object;
  }
  let planet;
  switch (shape) {
    case 'random-rotations':
    case 'figure-eight': mesh(new THREE.PlaneGeometry(1.4, 1.4)); break;
    case 'wobbly-cube':
    case 'diagonal-cube': mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1)); break;
    case 'photo-cube': mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1)); break;
    case 'rotating-sphere':
    case 'expanding-balloon': mesh(new THREE.SphereGeometry(0.8, 48, 24)); break;
    case 'low-poly-sphere': mesh(new THREE.IcosahedronGeometry(0.85, 1)); break;
    case 'inside-sphere': mesh(new THREE.SphereGeometry(2, 48, 24)); break;
    case 'pyramid': mesh(new THREE.ConeGeometry(0.85, 1.5, 4)); break;
    case 'rotating-donut': mesh(new THREE.TorusGeometry(0.57, 0.23, 24, 48)); break;
    case 'rotating-head': {
      const head = mesh(new THREE.SphereGeometry(0.58, 32, 24));
      head.scale.set(0.87, 1.25, 0.82);
      const nose = mesh(new THREE.ConeGeometry(0.12, 0.3, 8), 0, 0, 0.51);
      nose.rotation.x = Math.PI / 2;
      for (const x of [-0.5, 0.5]) {
        const ear = mesh(new THREE.SphereGeometry(0.13, 12, 8), x, 0.02, 0);
        ear.scale.set(0.55, 1.3, 0.8);
        mesh(new THREE.SphereGeometry(0.065, 12, 8), x * 0.43, 0.16, 0.45);
      }
      const jaw = mesh(new THREE.SphereGeometry(0.33, 20, 12), 0, -0.4, 0.12);
      jaw.scale.set(1.05, 0.7, 1);
      break;
    }
    case 'sun-and-planet':
      mesh(new THREE.SphereGeometry(0.5, 32, 16));
      planet = mesh(new THREE.SphereGeometry(0.22, 24, 12), 1.05);
      break;
    default: throw new Error(`Unknown bundled shape: ${shape}`);
  }
  group.scale.setScalar(scale);
  return {
    render(input, target, frame) {
      if (!material.map) material.needsUpdate = true;
      material.map = input;
      camera.aspect = frame.width / frame.height;
      camera.updateProjectionMatrix();
      const a = 2 * Math.PI * frame.progress(loop);
      group.rotation.set(tilt, a, 0);
      if (shape === 'wobbly-cube') group.rotation.set(tilt + Math.sin(a) * 0.5, a, Math.cos(a) * 0.3);
      if (shape === 'diagonal-cube') group.quaternion.setFromAxisAngle(new THREE.Vector3(1, 1, 1).normalize(), a);
      if (shape === 'random-rotations') {
        const phase = seed * 0.013;
        group.rotation.set(Math.sin(a + phase) * 2, Math.sin(a * 2 + phase) * 2, Math.cos(a + phase) * 2);
      }
      if (shape === 'figure-eight') group.position.set(Math.sin(a) * 0.65, Math.sin(a * 2) * 0.3, 0);
      if (shape === 'inside-sphere') group.rotation.set(tilt, Math.sin(a) * (0.6 + tilt), 0);
      if (shape === 'expanding-balloon') group.scale.setScalar(scale * (0.03 + frame.progress(loop) * 2.2));
      if (shape === 'photo-cube') {
        const phase = frame.progress(loop) * 4, local = phase % 1;
        const f = THREE.MathUtils.smoothstep(local, 0.2, 0.8);
        group.rotation.set(tilt * Math.sin(Math.PI * local), (Math.floor(phase) + f) * Math.PI / 2, 0);
        group.scale.setScalar(scale * (1.0 - 0.35 * Math.sin(Math.PI * local)));
      }
      if (planet) {
        group.rotation.set(tilt, 0, 0);
        planet.position.set(Math.cos(a) * 1.05, 0, Math.sin(a) * 1.05);
        planet.rotation.y = a;
      }
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },
    dispose() { material.dispose(); geometries.forEach((g) => g.dispose()); },
  };
}
