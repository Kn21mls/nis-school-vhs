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
  scene.environmentIntensity = 0.86;
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

function shadeFloor(material, lightmap, atriumLight, ceiling, stone) {
  const tiled = /^(floor_f[12]|granite)$/.test(material.name);
  const polished = material.name === 'floor_f2';
  const granite = material.name === 'granite';
  material.customProgramCacheKey = () => 'floor-light-' + [tiled, polished, granite].join('-');
  material.onBeforeCompile = shader => {
    shader.uniforms.floorLight = {value:lightmap};
    shader.uniforms.atriumLight = {value:atriumLight};
    shader.uniforms.stoneGrain = {value:stone};
    shader.uniforms.ceilingRadiance = {value:ceiling};
    shader.uniforms.showFloorReflections = showFloorReflections;
    shader.vertexShader = 'varying vec3 surfaceWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      surfaceWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      #include <project_vertex>`);
    shader.fragmentShader = 'varying vec3 surfaceWorld;\nuniform sampler2D floorLight;uniform sampler2D atriumLight;uniform sampler2D stoneGrain;uniform sampler2D ceilingRadiance;uniform bool showFloorReflections;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 baked = texture2D(floorLight, (surfaceWorld.xz - vec2(4.,0.)) / vec2(128.,96.)).rg;
      float visibility = mix(baked.r, baked.g, smoothstep(1.6,2.6,surfaceWorld.y));
      diffuseColor.rgb *= visibility;
      ${polished ? `
        vec2 localUv = (surfaceWorld.xz - vec2(50.,24.)) / 36.;
        vec2 margin = min(localUv, 1. - localUv);
        float coverage = smoothstep(0., .09, min(margin.x, margin.y))
          * (1. - smoothstep(.06, .5, abs(surfaceWorld.y - 3.6)));
        float bakedLight = texture2D(atriumLight, vec2(localUv.x, 1.-localUv.y)).r;
        diffuseColor.rgb *= mix(1., clamp(exp2((bakedLight-.5)*4.5), .24, 2.4), coverage);
      ` : ''}
      ${granite ? `
        float grain = texture2D(stoneGrain, vec2(surfaceWorld.x + surfaceWorld.z, surfaceWorld.y + surfaceWorld.z*.13)*2.5).r;
        diffuseColor.rgb *= mix(.29, 1.65, grain);
      ` : ''}
      ${tiled ? `
        vec2 grid = surfaceWorld.xz / 0.60;
        vec2 grad = max(fwidth(grid), vec2(0.0001));
        vec2 edge = 0.5 - abs(fract(grid) - 0.5);
        vec2 grout = 1.0 - smoothstep(vec2(0.), grad + 0.004, edge);
        float seam = max(grout.x, grout.y) * (1.0-smoothstep(0.04,0.28,max(grad.x,grad.y)));
        float tile = fract(sin(dot(floor(grid),vec2(12.9898,78.233)))*43758.5453);
        diffuseColor.rgb *= (0.97 + 0.06 * tile) * (1.0 - seam * 0.27);
      ` : ''}`);
    if (polished) {
      // Intersect the reflected view ray with the baked ceiling. Mip bias softens
      // the light panels in the floor finish and avoids another scene render.
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        if (showFloorReflections && coverage > .001) {
          vec3 viewRay = normalize(surfaceWorld - cameraPosition);
          vec3 reflected = reflect(viewRay, vec3(0.,1.,0.));
          vec2 ceilingXZ = surfaceWorld.xz + reflected.xz * (6.82-surfaceWorld.y)/max(reflected.y, .08);
          vec2 reflectionUv = (ceilingXZ - vec2(50.,24.)) / 36.;
          vec2 border = min(reflectionUv,1.-reflectionUv);
          float edgeFade = smoothstep(0.,.06,min(border.x,border.y));
          vec3 lightAbove = exp2(texture2D(ceilingRadiance, reflectionUv, 2.).rgb * 5.) - 1.;
          float fresnel = .045 + .38*pow(1.-clamp(reflected.y,0.,1.),4.);
          outgoingLight += lightAbove * fresnel * edgeFade * coverage * smoothstep(.04,.16,reflected.y);
        }
        #include <opaque_fragment>
      `);
    }
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
  const [lightmap, atriumLight, ceiling] = await Promise.all([
    loader.loadAsync('floor-light.png'), loader.loadAsync('atrium-light.png'), loader.loadAsync('atrium-ceiling.png')
  ]);
  // A seamless, mipmapped mineral grain tile is shared by all granite surfaces.
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
  lightmap.flipY = false;
  lightmap.needsUpdate = true;
  const materials = new Set();
  model.traverse(object => { if (object.isMesh) materials.add(object.material); });
  for (const material of materials) {
    if (material.transparent && material.side === T.DoubleSide) material.forceSinglePass = true;
    if (material.map) material.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (/^(floor_|room_|courtyard$|granite$)/.test(material.name)) shadeFloor(material, lightmap, atriumLight, ceiling, stone);
    if (material.name === 'floor_f2') {
      material.roughness = .23;
      material.clearcoatRoughness = .24;
      material.clearcoat = .28;
    }
    if (material.name === 'granite') material.roughness = .28;
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
    material.needsUpdate = true;
  }
}

