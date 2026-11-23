import * as T from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const showFloorReflections = { value: true };
let lampHalos;
export function setInteriorQuality(quality) {
  showFloorReflections.value = quality !== 'low';
  if (lampHalos) lampHalos.visible = showFloorReflections.value;
}

export async function lightInterior(renderer, scene) {
  const [panorama, lamps] = await Promise.all([
    new RGBELoader().loadAsync('atrium-probe.hdr'),
    new T.FileLoader().setResponseType('json').loadAsync('atrium-lamps.json')
  ]);
  const generator = new T.PMREMGenerator(renderer);
  const reflections = generator.fromEquirectangular(panorama);
  scene.environment = reflections.texture;
  scene.environmentIntensity = 0.5;   // reflections only; diffuse fill comes from the bake
  generator.dispose();
  panorama.dispose();
  renderer.toneMapping = T.AgXToneMapping;
  renderer.toneMappingExposure = 0.84;
  scene.add(new T.HemisphereLight(0xe4efff, 0xa79885, 0.32));
  const daylight = new T.DirectionalLight(0xfff3df, 0.40);
  daylight.position.set(-22, 32, 17);
  scene.add(daylight);
  const chandelier = new T.PointLight(0xffc78c, 70, 13, 2);
  chandelier.position.set(70.86, 5.2, 44.76);
  scene.add(chandelier);
  const dots = new T.BufferGeometry();
  dots.setAttribute('position', new T.Float32BufferAttribute(lamps, 3));
  const halo = new T.PointsMaterial({
    color: 0xffb66e, size: .28, transparent: true, opacity: .28,
    blending: T.AdditiveBlending, depthWrite: false, toneMapped: false
  });
  halo.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', `
      vec2 offset = gl_PointCoord * 2. - 1.;
      diffuseColor.a *= pow(max(1. - dot(offset,offset), 0.), 3.);
    `);
  };
  const glow = new T.Points(dots, halo);
  lampHalos = glow;
  glow.visible = showFloorReflections.value;
  glow.renderOrder = 1;
  scene.add(glow);
}

// Scene exposure of models/SchoolWalk.blend (AgX, -1.15 EV). Baked floor radiance is in
// Cycles' linear units; this maps it to the site's tone-mapping exposure.
const BLENDER_EXPOSURE = 2 ** -1.15;

// Floors use what Cycles computed: baked albedo tiles (terrazzo, linoleum, tiles) times the
// baked radiance of an albedo-1 floor (tools/bake_floor_cycles.py). Real-time lights only
// add the weak coat reflection on top, so floors keep the render's brightness and shadows.
function shadeFloor(material, bake, gain) {
  const albedo = bake.albedo[material.name];
  const grout = !albedo && /^(floor_f1|granite)$/.test(material.name);
  material.customProgramCacheKey = () => 'floor-bake-' + material.name;
  material.onBeforeCompile = shader => {
    shader.uniforms.floorLight1 = {value: bake.light1};
    shader.uniforms.floorLight2 = {value: bake.light2};
    shader.uniforms.floorLight3 = {value: bake.light3};
    shader.uniforms.irradianceMax = {value: bake.max};
    shader.uniforms.bakeGain = gain;
    if (albedo) {
      shader.uniforms.albedoMap = {value: albedo.map};
      shader.uniforms.albedoTile = {value: albedo.tile};
    }
    shader.vertexShader = 'varying vec3 surfaceWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      surfaceWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      #include <project_vertex>`);
    shader.fragmentShader = 'varying vec3 surfaceWorld;\nuniform sampler2D floorLight1;uniform sampler2D floorLight2;uniform sampler2D floorLight3;uniform float irradianceMax;uniform float bakeGain;\n'
      + (albedo ? 'uniform sampler2D albedoMap;uniform float albedoTile;\n' : '') + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      ${albedo ? 'diffuseColor.rgb = texture2D(albedoMap, surfaceWorld.xz / albedoTile).rgb;' : ''}
      ${grout ? `
        vec2 grid = surfaceWorld.xz / 0.60;
        vec2 grad = max(fwidth(grid), vec2(0.0001));
        vec2 edge = 0.5 - abs(fract(grid) - 0.5);
        vec2 groove = 1.0 - smoothstep(vec2(0.), grad + 0.004, edge);
        float seam = max(groove.x, groove.y) * (1.0-smoothstep(0.04,0.28,max(grad.x,grad.y)));
        diffuseColor.rgb *= 1.0 - seam * 0.22;
      ` : ''}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `
      #include <lights_fragment_end>
      vec2 bakeUv = (surfaceWorld.xz - vec2(4.,0.)) / vec2(128.,96.);
      vec4 bakedFloor = surfaceWorld.y < 2.1 ? texture2D(floorLight1, bakeUv) : surfaceWorld.y < 7.3 ? texture2D(floorLight2, bakeUv) : texture2D(floorLight3, bakeUv);
      if (bakedFloor.a > .5) {
        vec3 radiance = bakedFloor.rgb * bakedFloor.rgb * irradianceMax;
        reflectedLight.directDiffuse = vec3(0.);
        reflectedLight.indirectDiffuse = diffuseColor.rgb * radiance * bakeGain;
      }`);
  };
}

// Walls, ceilings and furniture take their ambient light from the same Cycles bake: the
// radiance baked on the floor of that part of the building (floor 1 below 3.3 m, floor 2
// above), scaled by which way the surface faces. This replaces the uniform hemisphere/IBL
// fill, so bright daylit rooms stay bright and the atrium is not over-lit, as in the render.
function bakedAmbient(material, bake, gain) {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => previousKey.call(material) + '-baked-ambient';
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.ambientLight1 = {value: bake.light1};
    shader.uniforms.ambientLight2 = {value: bake.light2};
    shader.uniforms.ambientLight3 = {value: bake.light3};
    shader.uniforms.ambientMax = {value: bake.max};
    shader.uniforms.ambientGain = gain;
    shader.vertexShader = 'varying vec3 bakeWorld;\n' + shader.vertexShader.replace('#include <project_vertex>', `
      bakeWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      #include <project_vertex>`);
    shader.fragmentShader = 'varying vec3 bakeWorld;\nuniform sampler2D ambientLight1;uniform sampler2D ambientLight2;uniform sampler2D ambientLight3;uniform float ambientMax;uniform float ambientGain;\n'
      + shader.fragmentShader.replace('#include <lights_fragment_end>', `
      #include <lights_fragment_end>
      {
        vec2 ambientUv = (bakeWorld.xz - vec2(4.,0.)) / vec2(128.,96.);
        vec4 area = bakeWorld.y < 3.3 ? texture2D(ambientLight1, ambientUv) : texture2D(ambientLight2, ambientUv);
        if (bakeWorld.y >= 7.4) {
          // Floor 3 exists only over the maths wing; elsewhere tall rooms (atrium, info centre) keep floor 2's light.
          vec4 upper = texture2D(ambientLight3, ambientUv);
          if (upper.a > .5) area = upper;
        }
        if (area.a > .5) {
          vec3 worldNormal = normalize((vec4(normal, 0.) * viewMatrix).xyz);
          float facing = .84 + .16 * worldNormal.y;
          reflectedLight.indirectDiffuse = diffuseColor.rgb * area.rgb * area.rgb * ambientMax * ambientGain * facing;
          reflectedLight.directDiffuse *= .5;
        }
      }`);
  };
}

// Granite columns: fine mineral grain around the flat colour, as subtle as in the render.
function stoneGrain(material, stone) {
  material.customProgramCacheKey = () => 'granite-grain';
  material.onBeforeCompile = shader => {
    shader.uniforms.stoneGrain = {value: stone};
    shader.vertexShader = 'varying vec3 surfaceWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      surfaceWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      #include <project_vertex>`);
    shader.fragmentShader = 'varying vec3 surfaceWorld;\nuniform sampler2D stoneGrain;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float grain = texture2D(stoneGrain, vec2(surfaceWorld.x + surfaceWorld.z, surfaceWorld.y + surfaceWorld.z*.13)*2.5).r;
      diffuseColor.rgb *= mix(.72, 1.3, grain);`);
  };
}

// Ceiling tiles (60 cm grid) drawn in the shader: the scene builds them procedurally,
// which glTF cannot export, so the material arrives as a flat colour.
function gridCeiling(material) {
  material.customProgramCacheKey = () => 'ceiling-grid-' + material.name;
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 surfaceWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      surfaceWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      #include <project_vertex>`);
    shader.fragmentShader = 'varying vec3 surfaceWorld;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 grid = ${material.name === 'ceiling_diag' ? 'mat2(.707107,.707107,-.707107,.707107) *' : ''} surfaceWorld.xz / 0.60;
      vec2 grad = max(fwidth(grid), vec2(0.0001));
      vec2 edge = 0.5 - abs(fract(grid) - 0.5);
      vec2 line = 1.0 - smoothstep(vec2(0.), grad + 0.012, edge);
      float seam = max(line.x, line.y) * (1.0 - smoothstep(0.05, 0.3, max(grad.x, grad.y)));
      diffuseColor.rgb *= 1.0 - seam * 0.3;`);
  };
}

export async function finishSurfaces(model, renderer) {
  const loader = new T.TextureLoader();
  const meta = await new T.FileLoader().setResponseType('json').loadAsync('floor-irradiance.json');
  const [light1, light2, light3] = await Promise.all(['floor-light-f1.png', 'floor-light-f2.png', 'floor-light-f3.png'].map(async file => {
    const map = await loader.loadAsync(file);
    map.flipY = false;
    map.colorSpace = T.NoColorSpace;
    map.premultiplyAlpha = false;
    map.generateMipmaps = false;
    map.minFilter = T.LinearFilter;
    map.needsUpdate = true;
    return map;
  }));
  const albedo = {};
  await Promise.all(Object.entries(meta.albedo).map(async ([name, tile]) => {
    const map = await loader.loadAsync(`albedo-${name}.jpg`);
    map.colorSpace = T.SRGBColorSpace;
    map.wrapS = map.wrapT = T.MirroredRepeatWrapping;
    map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    map.needsUpdate = true;
    albedo[name] = {map, tile};
  }));
  const bake = {light1, light2, light3, max: meta.max, albedo};
  const gain = {value: BLENDER_EXPOSURE / renderer.toneMappingExposure};
  // Mineral grain for the granite columns, kept subtle like the render.
  const size = 128, pixels = new Uint8Array(size * size);
  let seed = 7321;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const n = seed / 4294967296;
    pixels[i] = n < .13 ? 22 : n > .88 ? 237 : 92 + 78*n;
  }
  const stone = new T.DataTexture(pixels, size, size, T.RedFormat);
  stone.wrapS = stone.wrapT = T.RepeatWrapping;
  stone.magFilter = T.LinearFilter;
  stone.minFilter = T.LinearMipmapLinearFilter;
  stone.generateMipmaps = true;
  stone.needsUpdate = true;
  const materials = new Set();
  model.traverse(object => { if (object.isMesh) materials.add(object.material); });
  for (const material of materials) {
    if (material.transparent && material.side === T.DoubleSide) material.forceSinglePass = true;
    if (material.map) material.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (/^(floor_|room_|courtyard$|stair$)/.test(material.name)) shadeFloor(material, bake, gain);
    // Gloss as in the .blend (coat 0.12-0.2 on a rough base), not a mirror: no fake reflections.
    if (material.name === 'floor_f2') {
      material.roughness = .42;
      material.clearcoat = .12;
      material.clearcoatRoughness = .08;
    }
    if (/^room_/.test(material.name)) {
      material.roughness = .5;
      material.clearcoat = .08;
      material.clearcoatRoughness = .1;
    }
    if (material.name === 'granite') { stoneGrain(material, stone); material.roughness = .42; }
    if (material.name === 'drop_glass') {
      material.opacity = .53;
      material.emissiveIntensity = 1.8;
      material.depthWrite = false;
    }
    if (material.name === 'drop_light') material.emissiveIntensity = 19;
    if (material.name === 'plenum') material.color.setRGB(.007, .006, .005);
    if (material.name === 'grid_bronze') {
      material.color.setRGB(.29,.17,.065);
      material.metalness = .93;
    }
    if (material.name === 'ceiling' || material.name === 'ceiling_diag') gridCeiling(material);
    // Thin details that sit millimetres off a wall, floor or ceiling: pull them forward in depth
    // so they never fight with the surface behind them (flicker at a distance).
    if (/^(tactile|portrait|frame_gold|values_panel|ornament|led_panel|led_rim|fluor_tube|drop_light|ic_sign|sign_|tv_screen|laptop_screen|interactive_panel|chalkboard|blind|roller_blind|vertical_blind|stair_strip|skirting|locker_door|locker_inside|cabinet_oak|door_oak|radiator_white|cooler_white)/.test(material.name)) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -4;
    }
    if (/^(steel|steel_legs|stainless|aluminium|window_frame)$/.test(material.name)) {
      material.metalness = 0.79;
      material.roughness = 0.30;
    }
    if (/^(rail_glass|door_glass|glass)$/.test(material.name)) {
      material.roughness = 0.10;
      material.envMapIntensity = 0.9;
    }
    // Broad fabric highlights and tighter varnish reflections remain distinct under daylight.
    if (/^(hall_fabric|curtain_cream|bag_navy|bag_black)$/.test(material.name)) material.roughness = 0.94;
    if (/^leather_/.test(material.name)) material.roughness = 0.56;
    if (/^(hall_maple|desk_laminate|cabinet_oak|door_oak)$/.test(material.name)) material.roughness = 0.43;
    // Foliage and lacquered surfaces: matte like in the render, not lit by the atrium probe.
    if (/^(leaf_|plant_)/.test(material.name)) { material.roughness = .78; material.envMapIntensity = .25; }
    const floor = /^(floor_|room_|courtyard$|stair$)/.test(material.name);
    // Light sources and screens keep their own look; backlit blinds are lit like walls.
    const lamp = /^(led_|drop_|fluor_tube|tv_screen|laptop_screen|ic_sign|values_panel)/.test(material.name);
    if (!floor && !lamp && !material.transparent && material.isMeshStandardMaterial) bakedAmbient(material, bake, gain);
    material.needsUpdate = true;
  }
}

