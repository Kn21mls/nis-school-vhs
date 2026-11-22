import * as T from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function lightInterior(renderer, scene) {
  // Broad highlights stand in for the windows and ceiling panels around the viewer.
  const studio = new RoomEnvironment();
  const generator = new T.PMREMGenerator(renderer);
  const reflections = generator.fromScene(studio, 0.045);
  scene.environment = reflections.texture;
  scene.environmentIntensity = 0.52;
  generator.dispose();
  studio.dispose();
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  scene.add(new T.HemisphereLight(0xf3f8ff, 0xc3a78d, 1.18));
  const daylight = new T.DirectionalLight(0xffedcf, 1.65);
  daylight.position.set(-22, 32, 17);
  scene.add(daylight);
}

function shadeFloor(material, lightmap) {
  const tiled = /^(floor_f[12]|granite)$/.test(material.name);
  material.customProgramCacheKey = () => 'floor-light-' + tiled;
  material.onBeforeCompile = shader => {
    shader.uniforms.floorLight = {value:lightmap};
    shader.vertexShader = 'varying vec3 surfaceWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      surfaceWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      #include <project_vertex>`);
    shader.fragmentShader = 'varying vec3 surfaceWorld;\nuniform sampler2D floorLight;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 baked = texture2D(floorLight, (surfaceWorld.xz - vec2(4.,0.)) / vec2(128.,96.)).rg;
      float visibility = mix(baked.r, baked.g, smoothstep(1.6,2.6,surfaceWorld.y));
      diffuseColor.rgb *= visibility;
      ${tiled ? `
        vec2 grid = surfaceWorld.xz / 0.60;
        vec2 grad = max(fwidth(grid), vec2(0.0001));
        vec2 edge = 0.5 - abs(fract(grid) - 0.5);
        vec2 grout = 1.0 - smoothstep(vec2(0.), grad + 0.004, edge);
        float seam = max(grout.x, grout.y) * (1.0-smoothstep(0.04,0.28,max(grad.x,grad.y)));
        float tile = fract(sin(dot(floor(grid),vec2(12.9898,78.233)))*43758.5453);
        diffuseColor.rgb *= (0.97 + 0.06 * tile) * (1.0 - seam * 0.27);
      ` : ''}`);
  };
}

// Ceiling tiles (60 cm grid) drawn in the shader: the scene builds them procedurally,
// which glTF cannot export, so the material arrives as a flat colour.
function gridCeiling(material) {
  material.customProgramCacheKey = () => 'ceiling-grid';
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 surfaceWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      surfaceWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      #include <project_vertex>`);
    shader.fragmentShader = 'varying vec3 surfaceWorld;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 grid = surfaceWorld.xz / 0.60;
      vec2 grad = max(fwidth(grid), vec2(0.0001));
      vec2 edge = 0.5 - abs(fract(grid) - 0.5);
      vec2 line = 1.0 - smoothstep(vec2(0.), grad + 0.012, edge);
      float seam = max(line.x, line.y) * (1.0 - smoothstep(0.05, 0.3, max(grad.x, grad.y)));
      diffuseColor.rgb *= 1.0 - seam * 0.3;`);
  };
}

export async function finishSurfaces(model, renderer) {
  const lightmap = await new T.TextureLoader().loadAsync('floor-light.png');
  lightmap.flipY = false;
  lightmap.needsUpdate = true;
  const materials = new Set();
  model.traverse(object => { if (object.isMesh) materials.add(object.material); });
  for (const material of materials) {
    if (material.map) material.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (/^(floor_|room_|courtyard$|granite$)/.test(material.name)) shadeFloor(material, lightmap);
    if (material.name === 'ceiling') gridCeiling(material);
    if (/^(steel|steel_legs|stainless|aluminium|window_frame)$/.test(material.name)) {
      material.metalness = 0.79;
      material.roughness = 0.30;
    }
    if (/^(rail_glass|door_glass|glass)$/.test(material.name)) {
      material.roughness = 0.10;
      material.envMapIntensity = 0.9;
    }
    material.needsUpdate = true;
  }
}

