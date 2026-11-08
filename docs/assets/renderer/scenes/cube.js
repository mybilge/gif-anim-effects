import * as THREE from '../vendor/three-0.186.1/three.module.js';

export function create(renderer, { tilt, scale }, loop) {
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10);
  camera.position.z = 3.2;
  // Incoming layers are premultiplied: use ONE instead of SRC_ALPHA.
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  cube.rotation.x = tilt;
  cube.scale.setScalar(scale);
  const scene = new THREE.Scene().add(cube);
  return {
    render(input, target, frame) {
      const first = !material.map;
      material.map = input;
      if (first) material.needsUpdate = true;
      camera.aspect = frame.width / frame.height;
      camera.updateProjectionMatrix();
      cube.rotation.y = 2 * Math.PI * frame.progress(loop);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },
    dispose() { material.dispose(); cube.geometry.dispose(); },
  };
}
